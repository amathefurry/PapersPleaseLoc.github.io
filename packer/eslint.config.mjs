import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import node from 'eslint-plugin-n';
import promise from 'eslint-plugin-promise';
import unicorn from 'eslint-plugin-unicorn';

import { globalIgnores } from 'eslint/config';

const sourceFiles = ['**/*.{js,mjs}'];

export default [
    globalIgnores([
        'node_modules/**',
        'coverage/**',
        'dist/**',
        'build/**',
        '__tmp__/**',
    ]),

    {
        ...js.configs.recommended,
        files: sourceFiles,
    },

    {
        ...node.configs['flat/recommended-module'],
        files: sourceFiles,
    },

    {
        ...promise.configs['flat/recommended'],
        files: sourceFiles,
    },

    {
        ...unicorn.configs.unopinionated,
        files: sourceFiles,
    },

    {
        ...stylistic.configs.customize({
            indent: 4,
            quotes: 'single',
            commaDangle: 'only-multiline',
            semi: true,
            jsx: false,
            braceStyle: '1tbs',
            quoteProps: 'as-needed',
        }),
        files: sourceFiles,
    },

    {
        files: sourceFiles,

        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
        },

        linterOptions: {
            reportUnusedDisableDirectives: 'error',
            reportUnusedInlineConfigs: 'error',
        },

        rules: {
            curly: ['error', 'all'],
            eqeqeq: ['error', 'always'],

            'no-shadow': 'error',

            'no-use-before-define': [
                'error',
                {
                    functions: false,
                    classes: true,
                    variables: true,
                },
            ],

            'no-unused-vars': [
                'error',
                {
                    args: 'after-used',
                    argsIgnorePattern: '^_',
                    caughtErrors: 'all',
                    caughtErrorsIgnorePattern: '^_',
                    ignoreRestSiblings: true,
                },
            ],

            'no-var': 'error',
            'object-shorthand': 'error',
            'prefer-const': 'error',
            'prefer-object-has-own': 'error',

            'n/prefer-node-protocol': 'error',

            'no-console': 'off',

            'unicorn/prefer-module': 'error',
        },
    },

    {
        files: ['eslint.config.mjs'],

        rules: {
            'n/no-unpublished-import': 'off',
        },
    },
];
