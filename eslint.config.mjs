import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{ ignores: [".agents/**", "main.js", "node_modules/**", ".tmp-tests/**"] },
	eslint.configs.recommended,
	...tseslint.configs.recommendedTypeChecked,
	obsidianmd.configs.recommended,
	prettier,
	{
		languageOptions: {
			globals: { ...globals.browser, ...globals.node },
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"@typescript-eslint/no-explicit-any": "error",
			"@typescript-eslint/no-floating-promises": "error",
			"@typescript-eslint/no-unsafe-assignment": "off",
			"@typescript-eslint/no-unsafe-member-access": "off",
			"obsidianmd/settings-tab/no-manual-html-headings": "off",
			"obsidianmd/settings-tab/prefer-setting-definitions": "off",
			"obsidianmd/ui/sentence-case": "off",
		},
	},
	{
		files: ["tests/**/*.ts"],
		rules: { "@typescript-eslint/no-floating-promises": "off" },
	},
);
