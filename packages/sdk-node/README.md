# Pixel Forge SDK

Node SDK for Pixel Forge screenshot bootstrap workflows.

## Install

```bash
npm install @pixel-forge/sdk
```

## Use

```js
import { generateFromFile } from "@pixel-forge/sdk";

const result = await generateFromFile("./design.png", {
  apiKey: process.env.ANTHROPIC_API_KEY,
});

console.log(result.code);
```

The SDK keeps the screenshot bootstrap prompt strategy that Pixel Forge uses for high-fidelity HTML/Tailwind generation.

The previous long-form SDK notes were archived to `README-legacy-20260314.md`.
