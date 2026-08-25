import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Rendered manifests are intentionally untyped (Record<string, unknown>):
    // they mirror the Cloud Run / Knative API, which we do not model as TS types
    // because `overlay` lets callers add fields we have never heard of. Tests
    // have to reach deep into that structure, and threading casts through every
    // assertion would hurt readability without catching anything — the schema
    // and the golden fixtures are what constrain the shape.
    files: ['tests/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
)
