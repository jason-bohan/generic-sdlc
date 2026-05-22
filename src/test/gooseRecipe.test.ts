import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';

const RECIPE_PATH = resolve(__dirname, '../../recipes/create-story.yaml');

const VALID_INPUT_TYPES = ['string', 'number', 'boolean', 'date', 'file', 'select'];
const VALID_REQUIREMENTS = ['required', 'optional', 'user_prompt'];

describe('Goose recipe schema validation', () => {
    let recipe: any;

    it('parses as valid YAML', () => {
        const raw = readFileSync(RECIPE_PATH, 'utf-8');
        recipe = parseYaml(raw);
        expect(recipe).toBeDefined();
    });

    it('has required top-level fields', () => {
        recipe = parseYaml(readFileSync(RECIPE_PATH, 'utf-8'));
        expect(recipe.title).toBeTypeOf('string');
        expect(recipe.description).toBeTypeOf('string');
        expect(recipe.instructions || recipe.prompt).toBeTruthy();
    });

    it('version is a string if present', () => {
        recipe = parseYaml(readFileSync(RECIPE_PATH, 'utf-8'));
        if (recipe.version) {
            expect(recipe.version).toBeTypeOf('string');
        }
    });

    it('parameters is an array (not a map)', () => {
        recipe = parseYaml(readFileSync(RECIPE_PATH, 'utf-8'));
        expect(Array.isArray(recipe.parameters)).toBe(true);
    });

    it('each parameter has all 4 required fields: key, input_type, requirement, description', () => {
        recipe = parseYaml(readFileSync(RECIPE_PATH, 'utf-8'));
        for (const [i, param] of recipe.parameters.entries()) {
            expect(param.key, `parameters[${i}] missing "key"`).toBeTypeOf('string');
            expect(param.input_type, `parameters[${i}] (${param.key}) missing "input_type"`).toBeTypeOf('string');
            expect(param.requirement, `parameters[${i}] (${param.key}) missing "requirement"`).toBeTypeOf('string');
            expect(param.description, `parameters[${i}] (${param.key}) missing "description"`).toBeTypeOf('string');
        }
    });

    it('input_type values are valid', () => {
        recipe = parseYaml(readFileSync(RECIPE_PATH, 'utf-8'));
        for (const param of recipe.parameters) {
            expect(
                VALID_INPUT_TYPES,
                `parameters "${param.key}" has invalid input_type "${param.input_type}"`,
            ).toContain(param.input_type);
        }
    });

    it('requirement values are valid', () => {
        recipe = parseYaml(readFileSync(RECIPE_PATH, 'utf-8'));
        for (const param of recipe.parameters) {
            expect(
                VALID_REQUIREMENTS,
                `parameters "${param.key}" has invalid requirement "${param.requirement}"`,
            ).toContain(param.requirement);
        }
    });

    it('optional parameters have a default value', () => {
        recipe = parseYaml(readFileSync(RECIPE_PATH, 'utf-8'));
        for (const param of recipe.parameters) {
            if (param.requirement === 'optional') {
                expect(
                    param.default,
                    `optional parameter "${param.key}" must have a "default" value`,
                ).toBeDefined();
            }
        }
    });

    it('required parameters do NOT have a default value', () => {
        recipe = parseYaml(readFileSync(RECIPE_PATH, 'utf-8'));
        for (const param of recipe.parameters) {
            if (param.requirement === 'required') {
                expect(
                    param.default,
                    `required parameter "${param.key}" must NOT have a "default" value`,
                ).toBeUndefined();
            }
        }
    });

    it('select parameters have an options array', () => {
        recipe = parseYaml(readFileSync(RECIPE_PATH, 'utf-8'));
        for (const param of recipe.parameters) {
            if (param.input_type === 'select') {
                expect(
                    Array.isArray(param.options),
                    `select parameter "${param.key}" must have an "options" array`,
                ).toBe(true);
            }
        }
    });

    it('parameter keys are unique', () => {
        recipe = parseYaml(readFileSync(RECIPE_PATH, 'utf-8'));
        const keys = recipe.parameters.map((p: any) => p.key);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it('parameter keys are alphanumeric/underscores only', () => {
        recipe = parseYaml(readFileSync(RECIPE_PATH, 'utf-8'));
        for (const param of recipe.parameters) {
            expect(param.key).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
        }
    });

    it('does not use disallowed fields (name, type, required)', () => {
        recipe = parseYaml(readFileSync(RECIPE_PATH, 'utf-8'));
        for (const param of recipe.parameters) {
            expect(param.name, `parameter has forbidden field "name" — use "key" instead`).toBeUndefined();
            expect(param.type, `parameter has forbidden field "type" — use "input_type" instead`).toBeUndefined();
            expect(param.required, `parameter has forbidden field "required" — use "requirement" instead`).toBeUndefined();
        }
    });

    it('settings has valid provider/model if present', () => {
        recipe = parseYaml(readFileSync(RECIPE_PATH, 'utf-8'));
        if (recipe.settings) {
            if (recipe.settings.goose_provider) expect(recipe.settings.goose_provider).toBeTypeOf('string');
            if (recipe.settings.goose_model) expect(recipe.settings.goose_model).toBeTypeOf('string');
            if (recipe.settings.max_turns) expect(recipe.settings.max_turns).toBeTypeOf('number');
        }
    });

    it('extensions is an array of objects if present', () => {
        recipe = parseYaml(readFileSync(RECIPE_PATH, 'utf-8'));
        if (recipe.extensions) {
            expect(Array.isArray(recipe.extensions)).toBe(true);
            for (const ext of recipe.extensions) {
                expect(ext.type).toBeTypeOf('string');
                expect(ext.name).toBeTypeOf('string');
            }
        }
    });

    it('template variables in instructions match parameter keys', () => {
        recipe = parseYaml(readFileSync(RECIPE_PATH, 'utf-8'));
        const text = recipe.instructions || recipe.prompt || '';
        const templateVars = [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m: RegExpMatchArray) => m[1]);
        const paramKeys = new Set(recipe.parameters.map((p: any) => p.key));
        for (const v of templateVars) {
            expect(paramKeys.has(v), `template variable "{{ ${v} }}" has no matching parameter`).toBe(true);
        }
    });
});
