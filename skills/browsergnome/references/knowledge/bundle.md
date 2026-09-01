# Bundle size

### Bundle trimming — documented
When: Bundle analysis shows large unused exports from utility packages.
Do: Add `experimental.optimizePackageImports` and `compiler.removeConsole` (prod only) to `next.config.js`. Do NOT use `experimental.optimizeCss` — it's ineffective on App Router (Pages Router only); use CSS chunking or inlining strategies instead.
Evidence: reduces shipped bytes from partial-usage barrel packages; verify with `bundle_stats.mjs` chunk→module→bytes output.
- https://nextjs.org/docs/app/api-reference/config/next-config-js/optimizePackageImports
- https://nextjs.org/docs/architecture/nextjs-compiler (removeConsole under compiler options)
- https://github.com/vercel/next.js/discussions/80486 (experimental.optimizeCss App Router limitations)

See also: `Defer heavy JS` in `inp.md` (dynamic `import()` for non-critical libs) and `Island hydration` in `hydration-rsc.md` (reduces client JS for mostly-static pages).

### Dynamic imports with code-splitting — documented
When: A route or component has heavy, non-critical JS dependencies (charts, editors, media libraries).
Do: Use `next/dynamic` with `ssr: false` or native `import()` to defer loading until needed. Create separate chunks per major feature.
Evidence: Each deferred dependency loads on-demand, keeping initial bundle <100KB. Verified by @next/bundle-analyzer.
- https://nextjs.org/docs/app/guides/lazy-loading (next/dynamic and code-splitting)
- https://nextjs.org/docs/14/pages/building-your-application/optimizing/bundle-analyzer (@next/bundle-analyzer)

### Tree-shaking prerequisites — ungated hypothesis
When: Code analysis shows unused exports shipped to production or CommonJS re-exports in dependencies.
Do: Ensure dependencies export ESM (check package.json `"type": "module"` or .mjs files). Request or add `"sideEffects": false` to library package.json. Prefer barrel files only for type exports; import directly from submodules for runtime code.
Evidence: ESM + sideEffects:false enables tree-shaking; CommonJS remains opaque to bundlers.
- https://web.dev/reduce-javascript-payloads-with-tree-shaking/
- https://web.dev/commonjs-larger-bundles/ (why CommonJS blocks tree-shaking)
