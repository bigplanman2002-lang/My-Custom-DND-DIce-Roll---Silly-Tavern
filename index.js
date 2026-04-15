import { animation_duration } from '../../../../script.js';
import { renderExtensionTemplateAsync } from '../../../extensions.js';
import { POPUP_TYPE, callGenericPopup } from '../../../popup.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { commonEnumProviders } from '../../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { isTrueBoolean } from '../../../utils.js';

export { MODULE_NAME };

const MODULE_NAME = 'dice';
const TEMPLATE_PATH = 'third-party/My-Custom-DND-DIce-Roll---Silly-Tavern';

const ROLL_MODES = Object.freeze({
    NORMAL: 'normal',
    ADVANTAGE: 'advantage',
    DISADVANTAGE: 'disadvantage',
});

const defaultSettings = Object.freeze({
    functionTool: false,
    showDetails: true,
    defaultFormula: '1d20',
});

// ─── Settings ────────────────────────────────────────────────────────

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

// ─── Dice Engine ─────────────────────────────────────────────────────

function validate(formula) {
    return SillyTavern.libs.droll.validate(formula);
}

function rollRaw(formula) {
    return SillyTavern.libs.droll.roll(formula);
}

/**
 * Perform a dice roll.
 * @param {string} formula - Dice formula (e.g. "2d6+3")
 * @param {object} [options]
 * @param {boolean} [options.quiet] - Suppress chat output
 * @param {string}  [options.reason] - Why the roll is happening
 * @param {string}  [options.mode] - "normal" | "advantage" | "disadvantage"
 * @param {string}  [options.who] - Who is rolling (for chat display)
 * @returns {Promise<{total: string, rolls: string[], formula: string, mode: string}>}
 */
async function performRoll(formula, { quiet = false, reason = '', mode = ROLL_MODES.NORMAL, who = '' } = {}) {
    const empty = { total: '', rolls: [], formula: '', mode };
    formula = (formula || '').trim();
    if (!formula) formula = getSettings().defaultFormula;

    // Custom input prompt
    if (formula === 'custom') {
        formula = await callGenericPopup(
            'Enter dice formula:<br><i>Examples: <tt>2d6</tt>, <tt>1d20+5</tt>, <tt>4d6</tt></i>',
            POPUP_TYPE.INPUT,
            '',
            { okButton: 'Roll', cancelButton: 'Cancel' },
        );
        if (!formula) return empty;
        formula = formula.trim();
    }

    // Advantage / Disadvantage
    if (mode === ROLL_MODES.ADVANTAGE || mode === ROLL_MODES.DISADVANTAGE) {
        return rollAdvantageDisadvantage(formula, mode, { quiet, reason, who });
    }

    if (!validate(formula)) {
        toastr.warning(`Invalid dice formula: ${formula}`);
        return empty;
    }

    const result = rollRaw(formula);
    if (!result) return empty;

    const rollData = {
        total: String(result.total),
        rolls: result.rolls.map(String),
        formula,
        mode,
    };

    if (!quiet) {
        sendRollToChat(rollData, { reason, who });
    }
    return rollData;
}

/**
 * Roll with advantage or disadvantage: 2d20, pick high/low, add modifier.
 */
function rollAdvantageDisadvantage(formula, mode, { quiet, reason, who }) {
    const empty = { total: '', rolls: [], formula, mode };

    // Extract optional modifier from formula (e.g. "1d20+5" → +5)
    let modifier = 0;
    const modMatch = formula.match(/([+-]\d+)$/);
    if (modMatch) modifier = parseInt(modMatch[1], 10);

    const r1 = rollRaw('1d20');
    const r2 = rollRaw('1d20');
    if (!r1 || !r2) return empty;

    const v1 = r1.total;
    const v2 = r2.total;
    const chosen = mode === ROLL_MODES.ADVANTAGE ? Math.max(v1, v2) : Math.min(v1, v2);
    const total = chosen + modifier;
    const modStr = modifier !== 0 ? (modifier > 0 ? `+${modifier}` : String(modifier)) : '';

    const rollData = {
        total: String(total),
        rolls: [String(v1), String(v2)],
        formula: `2d20${modStr} (${mode})`,
        mode,
        chosen: String(chosen),
    };

    if (!quiet) {
        sendRollToChat(rollData, { reason, who });
    }
    return rollData;
}

/**
 * Format and send roll result as a system message.
 */
function sendRollToChat(rollData, { reason = '', who = '' } = {}) {
    const context = SillyTavern.getContext();
    const settings = getSettings();

    const roller = who || context.name1;
    const reasonText = reason ? ` for "${reason}"` : '';

    let message;
    if (rollData.mode === ROLL_MODES.ADVANTAGE || rollData.mode === ROLL_MODES.DISADVANTAGE) {
        const label = rollData.mode === ROLL_MODES.ADVANTAGE ? 'Advantage' : 'Disadvantage';
        const detail = settings.showDetails ? ` [${rollData.rolls.join(', ')}]` : '';
        message = `🎲 ${roller} rolls ${rollData.formula}${reasonText}. Result: **${rollData.total}**${detail} (${label}: chose ${rollData.chosen})`;
    } else {
        const detail = settings.showDetails && rollData.rolls.length > 1 ? ` [${rollData.rolls.join(', ')}]` : '';
        message = `🎲 ${roller} rolls ${rollData.formula}${reasonText}. Result: **${rollData.total}**${detail}`;
    }

    context.sendSystemMessage('generic', message, { isSmallSys: true });
}

// ─── Argument Sanitization (for function tool calls) ─────────────────

/**
 * Normalize AI-provided arguments into a clean {who, formula, mode, reason} object.
 * Handles: JSON strings, markdown-wrapped JSON, alternate key names,
 * bare dice formulas, natural language, nested objects, etc.
 * @param {any} args Raw arguments from the function tool
 * @returns {{who: string, formula: string, mode: string, reason: string}}
 */
function sanitizeArgs(args) {
    const fallback = { who: '', formula: getSettings().defaultFormula, mode: ROLL_MODES.NORMAL, reason: '' };

    // String input: try JSON parse, then regex extraction
    if (typeof args === 'string') {
        let str = args.trim();
        str = str.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        try {
            args = JSON.parse(str);
        } catch {
            const diceMatch = str.match(/(\d*d\d+(?:[+-]\d+)?)/i);
            return { ...fallback, formula: diceMatch ? diceMatch[1] : fallback.formula };
        }
    }

    if (!args || typeof args !== 'object') return fallback;

    // Unwrap nested wrappers: {arguments: {...}}, {parameters: {...}}, {input: {...}}
    for (const key of ['arguments', 'parameters', 'input']) {
        if (args[key] && typeof args[key] === 'object') {
            args = args[key];
            break;
        }
    }

    // Normalize "who"
    const who = args.who || args.name || args.character || args.player || args.persona || args.roller || '';

    // Normalize "reason"
    const reason = args.reason || args.description || args.purpose || args.for || '';

    // Normalize "mode"
    let mode = String(args.mode || args.roll_type || args.rollType || 'normal').toLowerCase();
    if (!Object.values(ROLL_MODES).includes(mode)) {
        if (/adv/i.test(mode)) mode = ROLL_MODES.ADVANTAGE;
        else if (/dis/i.test(mode)) mode = ROLL_MODES.DISADVANTAGE;
        else mode = ROLL_MODES.NORMAL;
    }

    // Normalize "formula"
    let formula = args.formula || args.dice || args.roll || args.die || args.dice_formula
        || args.diceFormula || args.notation || args.type || args.value || '';

    // Search all string values for a dice pattern as last resort
    if (!formula) {
        for (const val of Object.values(args)) {
            if (typeof val === 'string') {
                const m = val.match(/(\d*d\d+(?:[+-]\d+)?)/i);
                if (m) { formula = m[1]; break; }
            }
        }
    }

    // Clean up formula string
    if (typeof formula === 'string') {
        formula = formula.trim().replace(/^[("']+|[)"']+$/g, '');
        const cleaned = formula.match(/(\d*d\d+(?:[+-]\d+)?)/i);
        if (cleaned) formula = cleaned[1];
        if (/^d\d+/i.test(formula)) formula = '1' + formula;
    }

    return {
        who: String(who).trim(),
        formula: formula || fallback.formula,
        mode,
        reason: String(reason).trim(),
    };
}

// ─── Function Tool Registration ──────────────────────────────────────

function registerFunctionTools() {
    try {
        const { registerFunctionTool, unregisterFunctionTool } = SillyTavern.getContext();
        if (!registerFunctionTool || !unregisterFunctionTool) {
            console.debug('Dice: Function tools not supported in this version');
            return;
        }

        // Clean up any previous registrations
        unregisterFunctionTool('dnd_dice');
        unregisterFunctionTool('roll_dice');

        const settings = getSettings();
        if (!settings.functionTool) return;

        const rollDiceSchema = Object.freeze({
            type: 'object',
            properties: {
                who: {
                    type: 'string',
                    description: 'The name of the character rolling the dice.',
                },
                formula: {
                    type: 'string',
                    description: 'The dice formula. Use NdS format where N is number of dice and S is sides. Examples: 1d20, 2d6, 1d100, 1d20+5, 3d8-2.',
                },
                reason: {
                    type: 'string',
                    description: 'Why the dice is being rolled, e.g. attack roll, perception check, damage.',
                },
            },
            required: ['who', 'formula'],
        });

        registerFunctionTool({
            name: 'roll_dice',
            displayName: 'Roll Dice',
            description: 'You MUST call this tool to roll dice. When any dice roll, check, saving throw, attack, or random outcome is needed, ALWAYS use this tool. Never simulate or invent dice results. Pass who (character name) and formula (like 1d20 or 2d6+3).',
            parameters: rollDiceSchema,
            action: async (args) => {
                console.log('Dice: raw function tool args', args);
                const sanitized = sanitizeArgs(args);
                console.log('Dice: sanitized args', sanitized);

                const roll = await performRoll(sanitized.formula, {
                    quiet: false,
                    reason: sanitized.reason,
                    mode: sanitized.mode,
                    who: sanitized.who,
                });

                if (!roll.total) {
                    return 'Dice roll failed. The formula may be invalid.';
                }

                const whoText = sanitized.who ? `${sanitized.who} rolls` : 'Roll';
                const modeText = sanitized.mode !== ROLL_MODES.NORMAL ? ` with ${sanitized.mode}` : '';
                const reasonText = sanitized.reason ? ` for ${sanitized.reason}` : '';
                return `${whoText} ${sanitized.formula}${modeText}${reasonText}. Result: ${roll.total} (individual rolls: ${roll.rolls.join(', ')})`;
            },
            formatMessage: () => '',
        });

        console.log('Dice: Function tool registered');
    } catch (error) {
        console.error('Dice: Error registering function tools', error);
    }
}

// ─── UI Setup ────────────────────────────────────────────────────────

async function initUI() {
    const buttonHtml = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'button');
    const dropdownHtml = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'dropdown');
    const settingsHtml = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'settings');

    // Wand menu button
    const wandContainer = $(document.getElementById('dice_wand_container') ?? document.getElementById('extensionsMenu'));
    wandContainer.append(buttonHtml);

    // Settings panel
    const settingsContainer = $(document.getElementById('dice_container') ?? document.getElementById('extensions_settings2'));
    settingsContainer.append(settingsHtml);

    // Bind settings controls
    const settings = getSettings();

    $('#dice_function_tool').prop('checked', settings.functionTool).on('change', function () {
        settings.functionTool = !!$(this).prop('checked');
        saveSettings();
        registerFunctionTools();
    });

    $('#dice_show_details').prop('checked', settings.showDetails).on('change', function () {
        settings.showDetails = !!$(this).prop('checked');
        saveSettings();
    });

    $('#dice_default_formula').val(settings.defaultFormula).on('change', function () {
        const val = String($(this).val()).trim();
        if (val && validate(val)) {
            settings.defaultFormula = val;
            saveSettings();
        } else {
            toastr.warning('Invalid default formula');
            $(this).val(settings.defaultFormula);
        }
    });

    // Dropdown
    $(document.body).append(dropdownHtml);
    const button = $('#roll_dice');
    const dropdown = $('#dice_dropdown');
    dropdown.hide();

    // Dice option clicks (standard dice + custom)
    dropdown.on('click', '.dice-option', function () {
        const value = $(this).data('value');
        const mode = $(this).data('mode') || ROLL_MODES.NORMAL;
        dropdown.fadeOut(animation_duration);
        performRoll(String(value), { mode });
    });

    // Popper positioning
    const popper = SillyTavern.libs.Popper.createPopper(button.get(0), dropdown.get(0), {
        placement: 'top',
    });

    // Toggle dropdown on button click, close on outside click
    $(document).on('click touchend', function (e) {
        const target = $(e.target);
        if (target.is(dropdown) || target.closest(dropdown).length) return;
        if (target.is(button) || target.closest(button).length) {
            if (!dropdown.is(':visible')) {
                e.preventDefault();
                dropdown.fadeIn(animation_duration);
                popper.update();
            } else {
                dropdown.fadeOut(animation_duration);
            }
        } else {
            dropdown.fadeOut(animation_duration);
        }
    });
}

// ─── Slash Commands ──────────────────────────────────────────────────

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'roll',
        aliases: ['r', 'dice'],
        callback: async (args, value) => {
            const quiet = isTrueBoolean(String(args.quiet));
            const mode = String(args.mode || ROLL_MODES.NORMAL).toLowerCase();
            const reason = String(args.reason || '');
            const formula = String(value || getSettings().defaultFormula);
            const result = await performRoll(formula, { quiet, mode, reason });
            return result.total;
        },
        helpString: 'Roll dice using standard notation. Supports advantage/disadvantage via mode argument.',
        returns: 'numeric roll result',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'quiet',
                description: 'Suppress the result in chat',
                isRequired: false,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: String(false),
                enumProvider: commonEnumProviders.boolean('trueFalse'),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'mode',
                description: 'Roll mode: normal, advantage, or disadvantage',
                isRequired: false,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: ROLL_MODES.NORMAL,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'reason',
                description: 'Reason for the roll (shown in chat message)',
                isRequired: false,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Dice formula, e.g. 2d6, 1d20+5, 4d6',
                isRequired: false,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
    }));
}

// ─── Entry Point ─────────────────────────────────────────────────────

jQuery(async function () {
    try {
        await initUI();
        registerFunctionTools();
        registerSlashCommands();
        console.log('Dice: Extension loaded');
    } catch (error) {
        console.error('Dice: Failed to initialize', error);
    }
});
import { animation_duration } from '../../../../script.js';
import { renderExtensionTemplateAsync } from '../../../extensions.js';
import { POPUP_TYPE, callGenericPopup } from '../../../popup.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { commonEnumProviders } from '../../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { isTrueBoolean } from '../../../utils.js';

export { MODULE_NAME };

const MODULE_NAME = 'dice';
const TEMPLATE_PATH = 'third-party/Extension-Dice';

const ROLL_MODES = Object.freeze({
    NORMAL: 'normal',
    ADVANTAGE: 'advantage',
    DISADVANTAGE: 'disadvantage',
});

const defaultSettings = Object.freeze({
    functionTool: false,
    showDetails: true,
    defaultFormula: '1d20',
});

// ─── Settings ────────────────────────────────────────────────────────

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

// ─── Dice Engine ─────────────────────────────────────────────────────

function validate(formula) {
    return SillyTavern.libs.droll.validate(formula);
}

function rollRaw(formula) {
    return SillyTavern.libs.droll.roll(formula);
}

/**
 * Perform a dice roll.
 * @param {string} formula - Dice formula (e.g. "2d6+3")
 * @param {object} [options]
 * @param {boolean} [options.quiet] - Suppress chat output
 * @param {string}  [options.reason] - Why the roll is happening
 * @param {string}  [options.mode] - "normal" | "advantage" | "disadvantage"
 * @param {string}  [options.who] - Who is rolling (for chat display)
 * @returns {Promise<{total: string, rolls: string[], formula: string, mode: string}>}
 */
async function performRoll(formula, { quiet = false, reason = '', mode = ROLL_MODES.NORMAL, who = '' } = {}) {
    const empty = { total: '', rolls: [], formula: '', mode };
    formula = (formula || '').trim();
    if (!formula) formula = getSettings().defaultFormula;

    // Custom input prompt
    if (formula === 'custom') {
        formula = await callGenericPopup(
            'Enter dice formula:<br><i>Examples: <tt>2d6</tt>, <tt>1d20+5</tt>, <tt>4d6</tt></i>',
            POPUP_TYPE.INPUT,
            '',
            { okButton: 'Roll', cancelButton: 'Cancel' },
        );
        if (!formula) return empty;
        formula = formula.trim();
    }

    // Advantage / Disadvantage
    if (mode === ROLL_MODES.ADVANTAGE || mode === ROLL_MODES.DISADVANTAGE) {
        return rollAdvantageDisadvantage(formula, mode, { quiet, reason, who });
    }

    if (!validate(formula)) {
        toastr.warning(`Invalid dice formula: ${formula}`);
        return empty;
    }

    const result = rollRaw(formula);
    if (!result) return empty;

    const rollData = {
        total: String(result.total),
        rolls: result.rolls.map(String),
        formula,
        mode,
    };

    if (!quiet) {
        sendRollToChat(rollData, { reason, who });
    }
    return rollData;
}

/**
 * Roll with advantage or disadvantage: 2d20, pick high/low, add modifier.
 */
function rollAdvantageDisadvantage(formula, mode, { quiet, reason, who }) {
    const empty = { total: '', rolls: [], formula, mode };

    // Extract optional modifier from formula (e.g. "1d20+5" → +5)
    let modifier = 0;
    const modMatch = formula.match(/([+-]\d+)$/);
    if (modMatch) modifier = parseInt(modMatch[1], 10);

    const r1 = rollRaw('1d20');
    const r2 = rollRaw('1d20');
    if (!r1 || !r2) return empty;

    const v1 = r1.total;
    const v2 = r2.total;
    const chosen = mode === ROLL_MODES.ADVANTAGE ? Math.max(v1, v2) : Math.min(v1, v2);
    const total = chosen + modifier;
    const modStr = modifier !== 0 ? (modifier > 0 ? `+${modifier}` : String(modifier)) : '';

    const rollData = {
        total: String(total),
        rolls: [String(v1), String(v2)],
        formula: `2d20${modStr} (${mode})`,
        mode,
        chosen: String(chosen),
    };

    if (!quiet) {
        sendRollToChat(rollData, { reason, who });
    }
    return rollData;
}

/**
 * Format and send roll result as a system message.
 */
function sendRollToChat(rollData, { reason = '', who = '' } = {}) {
    const context = SillyTavern.getContext();
    const settings = getSettings();

    const roller = who || context.name1;
    const reasonText = reason ? ` for "${reason}"` : '';

    let message;
    if (rollData.mode === ROLL_MODES.ADVANTAGE || rollData.mode === ROLL_MODES.DISADVANTAGE) {
        const label = rollData.mode === ROLL_MODES.ADVANTAGE ? 'Advantage' : 'Disadvantage';
        const detail = settings.showDetails ? ` [${rollData.rolls.join(', ')}]` : '';
        message = `🎲 ${roller} rolls ${rollData.formula}${reasonText}. Result: **${rollData.total}**${detail} (${label}: chose ${rollData.chosen})`;
    } else {
        const detail = settings.showDetails && rollData.rolls.length > 1 ? ` [${rollData.rolls.join(', ')}]` : '';
        message = `🎲 ${roller} rolls ${rollData.formula}${reasonText}. Result: **${rollData.total}**${detail}`;
    }

    context.sendSystemMessage('generic', message, { isSmallSys: true });
}

// ─── Argument Sanitization (for function tool calls) ─────────────────

/**
 * Normalize AI-provided arguments into a clean {who, formula, mode, reason} object.
 * Handles: JSON strings, markdown-wrapped JSON, alternate key names,
 * bare dice formulas, natural language, nested objects, etc.
 * @param {any} args Raw arguments from the function tool
 * @returns {{who: string, formula: string, mode: string, reason: string}}
 */
function sanitizeArgs(args) {
    const fallback = { who: '', formula: getSettings().defaultFormula, mode: ROLL_MODES.NORMAL, reason: '' };

    // String input: try JSON parse, then regex extraction
    if (typeof args === 'string') {
        let str = args.trim();
        str = str.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        try {
            args = JSON.parse(str);
        } catch {
            const diceMatch = str.match(/(\d*d\d+(?:[+-]\d+)?)/i);
            return { ...fallback, formula: diceMatch ? diceMatch[1] : fallback.formula };
        }
    }

    if (!args || typeof args !== 'object') return fallback;

    // Unwrap nested wrappers: {arguments: {...}}, {parameters: {...}}, {input: {...}}
    for (const key of ['arguments', 'parameters', 'input']) {
        if (args[key] && typeof args[key] === 'object') {
            args = args[key];
            break;
        }
    }

    // Normalize "who"
    const who = args.who || args.name || args.character || args.player || args.persona || args.roller || '';

    // Normalize "reason"
    const reason = args.reason || args.description || args.purpose || args.for || '';

    // Normalize "mode"
    let mode = String(args.mode || args.roll_type || args.rollType || 'normal').toLowerCase();
    if (!Object.values(ROLL_MODES).includes(mode)) {
        if (/adv/i.test(mode)) mode = ROLL_MODES.ADVANTAGE;
        else if (/dis/i.test(mode)) mode = ROLL_MODES.DISADVANTAGE;
        else mode = ROLL_MODES.NORMAL;
    }

    // Normalize "formula"
    let formula = args.formula || args.dice || args.roll || args.die || args.dice_formula
        || args.diceFormula || args.notation || args.type || args.value || '';

    // Search all string values for a dice pattern as last resort
    if (!formula) {
        for (const val of Object.values(args)) {
            if (typeof val === 'string') {
                const m = val.match(/(\d*d\d+(?:[+-]\d+)?)/i);
                if (m) { formula = m[1]; break; }
            }
        }
    }

    // Clean up formula string
    if (typeof formula === 'string') {
        formula = formula.trim().replace(/^[("']+|[)"']+$/g, '');
        const cleaned = formula.match(/(\d*d\d+(?:[+-]\d+)?)/i);
        if (cleaned) formula = cleaned[1];
        if (/^d\d+/i.test(formula)) formula = '1' + formula;
    }

    return {
        who: String(who).trim(),
        formula: formula || fallback.formula,
        mode,
        reason: String(reason).trim(),
    };
}

// ─── Function Tool Registration ──────────────────────────────────────

function registerFunctionTools() {
    try {
        const { registerFunctionTool, unregisterFunctionTool } = SillyTavern.getContext();
        if (!registerFunctionTool || !unregisterFunctionTool) {
            console.debug('Dice: Function tools not supported in this version');
            return;
        }

        // Clean up any previous registrations
        unregisterFunctionTool('dnd_dice');
        unregisterFunctionTool('roll_dice');

        const settings = getSettings();
        if (!settings.functionTool) return;

        const rollDiceSchema = Object.freeze({
            type: 'object',
            properties: {
                who: {
                    type: 'string',
                    description: 'The name of the character rolling the dice.',
                },
                formula: {
                    type: 'string',
                    description: 'The dice formula. Use NdS format where N is number of dice and S is sides. Examples: 1d20, 2d6, 1d100, 1d20+5, 3d8-2.',
                },
                reason: {
                    type: 'string',
                    description: 'Why the dice is being rolled, e.g. attack roll, perception check, damage.',
                },
            },
            required: ['who', 'formula'],
        });

        registerFunctionTool({
            name: 'roll_dice',
            displayName: 'Roll Dice',
            description: 'You MUST call this tool to roll dice. When any dice roll, check, saving throw, attack, or random outcome is needed, ALWAYS use this tool. Never simulate or invent dice results. Pass who (character name) and formula (like 1d20 or 2d6+3).',
            parameters: rollDiceSchema,
            action: async (args) => {
                console.log('Dice: raw function tool args', args);
                const sanitized = sanitizeArgs(args);
                console.log('Dice: sanitized args', sanitized);

                const roll = await performRoll(sanitized.formula, {
                    quiet: false,
                    reason: sanitized.reason,
                    mode: sanitized.mode,
                    who: sanitized.who,
                });

                if (!roll.total) {
                    return 'Dice roll failed. The formula may be invalid.';
                }

                const whoText = sanitized.who ? `${sanitized.who} rolls` : 'Roll';
                const modeText = sanitized.mode !== ROLL_MODES.NORMAL ? ` with ${sanitized.mode}` : '';
                const reasonText = sanitized.reason ? ` for ${sanitized.reason}` : '';
                return `${whoText} ${sanitized.formula}${modeText}${reasonText}. Result: ${roll.total} (individual rolls: ${roll.rolls.join(', ')})`;
            },
            formatMessage: () => '',
        });

        console.log('Dice: Function tool registered');
    } catch (error) {
        console.error('Dice: Error registering function tools', error);
    }
}

// ─── UI Setup ────────────────────────────────────────────────────────

async function initUI() {
    const buttonHtml = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'button');
    const dropdownHtml = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'dropdown');
    const settingsHtml = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'settings');

    // Wand menu button
    const wandContainer = $(document.getElementById('dice_wand_container') ?? document.getElementById('extensionsMenu'));
    wandContainer.append(buttonHtml);

    // Settings panel
    const settingsContainer = $(document.getElementById('dice_container') ?? document.getElementById('extensions_settings2'));
    settingsContainer.append(settingsHtml);

    // Bind settings controls
    const settings = getSettings();

    $('#dice_function_tool').prop('checked', settings.functionTool).on('change', function () {
        settings.functionTool = !!$(this).prop('checked');
        saveSettings();
        registerFunctionTools();
    });

    $('#dice_show_details').prop('checked', settings.showDetails).on('change', function () {
        settings.showDetails = !!$(this).prop('checked');
        saveSettings();
    });

    $('#dice_default_formula').val(settings.defaultFormula).on('change', function () {
        const val = String($(this).val()).trim();
        if (val && validate(val)) {
            settings.defaultFormula = val;
            saveSettings();
        } else {
            toastr.warning('Invalid default formula');
            $(this).val(settings.defaultFormula);
        }
    });

    // Dropdown
    $(document.body).append(dropdownHtml);
    const button = $('#roll_dice');
    const dropdown = $('#dice_dropdown');
    dropdown.hide();

    // Dice option clicks (standard dice + custom)
    dropdown.on('click', '.dice-option', function () {
        const value = $(this).data('value');
        const mode = $(this).data('mode') || ROLL_MODES.NORMAL;
        dropdown.fadeOut(animation_duration);
        performRoll(String(value), { mode });
    });

    // Popper positioning
    const popper = SillyTavern.libs.Popper.createPopper(button.get(0), dropdown.get(0), {
        placement: 'top',
    });

    // Toggle dropdown on button click, close on outside click
    $(document).on('click touchend', function (e) {
        const target = $(e.target);
        if (target.is(dropdown) || target.closest(dropdown).length) return;
        if (target.is(button) || target.closest(button).length) {
            if (!dropdown.is(':visible')) {
                e.preventDefault();
                dropdown.fadeIn(animation_duration);
                popper.update();
            } else {
                dropdown.fadeOut(animation_duration);
            }
        } else {
            dropdown.fadeOut(animation_duration);
        }
    });
}

// ─── Slash Commands ──────────────────────────────────────────────────

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'roll',
        aliases: ['r', 'dice'],
        callback: async (args, value) => {
            const quiet = isTrueBoolean(String(args.quiet));
            const mode = String(args.mode || ROLL_MODES.NORMAL).toLowerCase();
            const reason = String(args.reason || '');
            const formula = String(value || getSettings().defaultFormula);
            const result = await performRoll(formula, { quiet, mode, reason });
            return result.total;
        },
        helpString: 'Roll dice using standard notation. Supports advantage/disadvantage via mode argument.',
        returns: 'numeric roll result',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'quiet',
                description: 'Suppress the result in chat',
                isRequired: false,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: String(false),
                enumProvider: commonEnumProviders.boolean('trueFalse'),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'mode',
                description: 'Roll mode: normal, advantage, or disadvantage',
                isRequired: false,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: ROLL_MODES.NORMAL,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'reason',
                description: 'Reason for the roll (shown in chat message)',
                isRequired: false,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Dice formula, e.g. 2d6, 1d20+5, 4d6',
                isRequired: false,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
    }));
}

// ─── Entry Point ─────────────────────────────────────────────────────

jQuery(async function () {
    try {
        await initUI();
        registerFunctionTools();
        registerSlashCommands();
        console.log('Dice: Extension loaded');
    } catch (error) {
        console.error('Dice: Failed to initialize', error);
    }
});
