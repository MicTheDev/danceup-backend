module.exports = {
  env: {
    es6: true,
    node: true,
  },
  extends: [
    "eslint:recommended",
    "google",
  ],
  rules: {
    "no-restricted-globals": ["error", "name", "length"],
    "prefer-arrow-callback": "error",
    "quotes": ["error", "double", {"allowTemplateLiterals": true}],
    "max-len": ["error", {"code": 120}],
    "require-jsdoc": "off",
    "valid-jsdoc": "off",
  },
  overrides: [
    {
      files: ["**/*.spec.*"],
      env: {
        mocha: true,
      },
      rules: {},
    },
  ],
  globals: {},
};
