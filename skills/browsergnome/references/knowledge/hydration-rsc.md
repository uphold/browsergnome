# Hydration / RSC

### Island hydration — ungated hypothesis
When: A mostly-static page ships a large client component for minor interactivity.
Do: Render static server HTML; one tiny `'use client'` component returns `null` and wires the DOM imperatively in `useEffect`; gate with `IntersectionObserver` so it doesn't run until needed.
Evidence: removes a large client bundle from a page that's structurally static — this is the direct fix for what the `clientComponentInServerTree` detector flags (a `'use client'` boundary sitting at a high-fan-in module). *Note: This specific pattern (returning `null` and imperatively wiring DOM) is not documented in [React](https://react.dev) or [Next.js official docs](https://nextjs.org/docs/app/getting-started/server-and-client-components); the standard recommendation is to minimize `'use client'` boundaries via the patterns below.*

---

### Minimize 'use client' boundaries — documented
When: Hydrating a large portion of your app unnecessarily; client component at a high-fan-in module pulls in large JS bundles.
Do: Keep `'use client'` boundaries as small and deep as possible. Only mark components `'use client'` that actually need browser APIs or user interaction; wrap interactivity at the leaf level, not the root or layout.
Evidence: [Next.js Server and Client Components guide](https://nextjs.org/docs/app/getting-started/server-and-client-components) explicitly recommends this; [tree-shaking enables selective imports from `'use client'` files](https://nextjs.org/docs/14/app/building-your-application/rendering/composition-patterns), reducing bundle size for the rest of the app.

---

### Streaming SSR with Suspense boundaries for progressive hydration — documented
When: Large pages with slow data sources; user experiences long First Contentful Paint (FCP) or a long wait before interactivity.
Do: Use `<Suspense>` boundaries to divide your page into independent hydration units. Render static shell (layout, nav, Suspense fallbacks) immediately; stream slower content after. React v18+ hydrates each `<Suspense>` boundary independently and [prioritizes hydration for content the user interacts with](https://react.dev/blog/2022/03/29/react-v18).
Evidence: [React v18.0 Suspense + selective hydration](https://react.dev/blog/2022/03/29/react-v18); [Next.js Streaming guide](https://nextjs.org/docs/14/app/building-your-application/routing/loading-ui-and-streaming); keeps main thread responsive by breaking hydration into smaller tasks instead of one blocking pass.
