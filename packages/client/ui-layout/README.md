# @deepseek-ai/dsh-client-ui-layout

English | [中文](README.zh.md)

Shell plugin: three-column AppFrame (drag handles and concession chain) plus the `ctx.layout` panel-geometry service; it registers into the runtime-owned `root` slot and declares `sidebar`, `conversation`, `details`, and `conversation.empty`. The sidebar resize boundary is an invisible hit strip, while the details boundary retains its floating pill; only details shrinks during concession and then auto-closes. A closed sidebar retains a 56px control rail while details closes to zero width. The package also seats the theme presenter: it consumes resolved `ctx.theme` snapshots and projects them onto the document (`html { color-scheme }` for native UA chrome, `body[data-ds-dark-theme]` from the active color scheme, the theme's alias tokens as inline variables on body, and one owned `<meta name="theme-color">` whose content follows the computed body background). Measuring after palette and token application keeps the rendered background as the single color authority; disposing the presenter removes its metadata node with its other global writes.

AppFrame always mounts the conversation and details columns; a connected Session renders through `SessionProvider`. The transient layout store starts the sidebar at its default width and details closed, and it never reads or writes `localStorage`. Hero and other unselected states also derive a zero rendered details width without changing that stored preference. AppFrame retains the last non-blank Session id across those states: the first Session remains closed, an explicit details action opens the contract default width, returning to the same Session restores its unchanged width, and selecting a different Session closes details before paint. When the ProbHub workbench is mounted, its controller follows the current Session and passes the Host's bounded report projection to the statement, health, and AI-copilot views; the statement tab can explicitly open a workspace-write source editor for an allowlisted `problem.md`, `probhub.yaml`, code, sample-input, or secret-input target with a Core revision fence. The health tab presents the current source/data, validation, preview-generation, and formal-publication checklist and can start non-publishing `judge`, `stress`, `judge-qa`, `mutation`, `checkpoint`, `seal`, and workspace-scoped `assemble` Jobs through the Host. Stress buttons use 1000 rounds and seed 12345 by default. Running jobs are disabled to prevent duplicate starts, and the workbench exposes a cancel action that requests cancellation through the Host; it also mirrors current-session ProbHub background jobs (`running`, `stopping`, `completed`, `failed`, or `killed`) from the shared session job stream. Formal Build remains an explicit later delivery step. Host tool results may focus a validated workbench tab without changing workspace files. The conversation owner share is empty, while the sidebar owner share contains only `collapsed` and `width`; registrants obtain business data from standard hooks and actions from their own inject faces.

The PDF tab embeds the current isolated preview generation through the same-origin Host route and stays unavailable when no generation is reported. Formal Build remains an explicit later delivery step. The `/client` exports are the plugin body (`apply`/`inject`), `LayoutController`, and the four owner-share interfaces. AppFrame, the panel store, and the concession solver remain package-internal.

## Model Experience

None, as the layout shell manages browser viewing state; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Panel geometry is transient** — reload restores the sidebar default and details closed; switching between distinct Session ids also closes details and forgets its dragged width, while unselected surfaces render details at zero width without modifying geometry.
- **Concession-chain auto-close derives a zero width without touching the preferred width** — the panel restores itself when the window widens; consumers must not read the stored details width as the rendered truth.
- **No scroll anchoring during squeeze reflow** — layout changes may move the reader's viewport.
- **ProbHub is opt-in at runtime** — profiles without the Host route keep the ordinary DSH conversation shell; an installed Host returns a workbench notice for migration or Core errors instead of showing unverified content.
- **Source editing is explicit** — the editor only offers the Host's allowlisted statement, config, code, sample-input, and secret-input targets; reads and saves go through the Host source bridge, require the Session's existing `workspace-write` policy, and surface revision conflicts instead of overwriting external changes.
