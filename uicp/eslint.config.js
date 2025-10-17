import js from '@eslint/js';
import typescriptPlugin from '@typescript-eslint/eslint-plugin';
import typescriptParser from '@typescript-eslint/parser';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import globals from 'globals';

// Flat config keeps ESLint 9 happy while mirroring the previous rule set.
export default [
  {
    ignores: ['dist', 'node_modules', 'target'],
  },
  js.configs.recommended,
  // Enforce no `as any` in uicp boundary code
  {
    files: ['src/lib/uicp/**/*.ts', 'src/lib/uicp/**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSAsExpression > TSAnyKeyword',
          message: 'E-UICP-0001: Do not use "as any" in uicp boundary code. Use precise types or proper narrowing.',
        },
      ],
    },
  },
  // Ban innerHTML usage (XSS prevention)
  {
    files: ['src/**/*.{ts,tsx,js,jsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'MemberExpression[property.name="innerHTML"][parent.type="AssignmentExpression"][parent.operator="="][parent.right.type!="Literal"][parent.right.value!=""]',
          message: 'E-SEC-0001: innerHTML assignment with dynamic content is forbidden (XSS risk). Use DOM APIs (createElement, textContent) or escapeHtml() for dynamic content.',
        },
        {
          selector: 'MemberExpression[property.name="innerHTML"][parent.type="AssignmentExpression"][parent.operator="="][parent.right.type="TemplateLiteral"]',
          message: 'E-SEC-0002: innerHTML with template literals is forbidden (XSS risk). Use DOM APIs (createElement, textContent) or pass through escapeHtml().',
        },
      ],
    },
  },
  {
    files: ['**/*.{ts,tsx}', '**/*.{js,jsx}'],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      '@typescript-eslint': typescriptPlugin,
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      ...typescriptPlugin.configs.recommended.rules,
      ...reactPlugin.configs.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
];
