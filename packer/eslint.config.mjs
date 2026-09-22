/* eslint-disable n/no-unpublished-import */
import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import node from 'eslint-plugin-n';
import promise from 'eslint-plugin-promise';
import unicorn from 'eslint-plugin-unicorn';

import {
	defineConfig,
	globalIgnores,
} from 'eslint/config';

export default defineConfig([
	globalIgnores([
		'node_modules/**',
		'coverage/**',
		'dist/**',
		'build/**',
		'__tmp__/**',
	]),

	{
		files: ['**/*.{js,cjs,mjs}'],

		plugins: {
			js,
			n: node,
			promise,
			unicorn,
		},

		extends: [
			'js/recommended',
			'n/recommended',
			'promise/flat/recommended',
			'unicorn/unopinionated',

			stylistic.configs.customize({
				indent: 'tab',
				quotes: 'single',
				semi: true,
				jsx: false,
				braceStyle: 'stroustrup',
				quoteProps: 'as-needed',
			}),
		],

		languageOptions: {
			ecmaVersion: 'latest',
		},

		linterOptions: {
			reportUnusedDisableDirectives: 'error',
			reportUnusedInlineConfigs: 'error',
		},

		rules: {
			/*
			 * Correctness
			 */
			curly: ['error', 'all'],

			eqeqeq: [
				'error',
				'always',
				{
					null: 'ignore',
				},
			],

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

			/*
			 * Modern JavaScript
			 */
			'no-var': 'error',
			'object-shorthand': 'error',
			'prefer-const': 'error',
			'prefer-object-has-own': 'error',

			/*
			 * Node
			 */
			'n/prefer-node-protocol': 'error',

			/*
			 * This is a command-line/build utility.
			 */
			'no-console': 'off',
			'n/no-process-exit': 'off',
			'n/no-sync': 'off',
			'unicorn/no-process-exit': 'off',
			'unicorn/prefer-module': 'error',
		},
	},

	/*
	 * index.js is Node code, but functions passed to page.evaluate()
	 * execute inside Playwright's browser context.
	 *
	 * Don't enable all browser globals for the entire project.
	 */
	{
		files: ['index.js'],

		languageOptions: {
			globals: {
				$: 'readonly',
				FileReader: 'readonly',
				window: 'readonly',
			},
		},
	},
]);