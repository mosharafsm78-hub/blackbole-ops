// What the theme editor (Website → Themes → Customize) can change, page by page.
// Mirrors the website's sections (blackbole-storefront export/theme/sections/bb26-*.liquid {% schema %} and the
// Astro pages that read them). Every field is optional: an empty field means "use the website's built-in value",
// shown as the placeholder.

export type FieldType = "text" | "textarea" | "url" | "collection" | "image" | "video" | "number" | "tiles" | "heromap" | "color"
export type ThemeField = { id: string; label: string; type: FieldType; placeholder?: string; help?: string; min?: number; max?: number
  /** the website's built-in file (public/assets/files/) used while the field is empty */
  def?: string
  /** false: the editor preview can't show this field before saving (it shows once the preview site rebuilds) */
  live?: boolean }
export type ThemeSection = {
  /** id in the page (home page: also the id used for order / hide) */
  id: string
  title: string
  help?: string
  /** where its settings live: templates[template].sections[section].settings */
  template: string
  section: string
  fields: ThemeField[]
  /** home page sections can be moved and hidden */
  movable?: boolean
  /** false: the editor preview can't show changes before saving (it shows them once the preview site rebuilds) */
  live?: boolean
}
export type ThemePage = { id: string; title: string; path: string; sections: ThemeSection[]; note?: string }

const home = (id: string, title: string, fields: ThemeField[], help?: string): ThemeSection =>
  ({ id, title, help, template: "index", section: "home", fields, movable: true })

export const HOME_ORDER_KEY = "sections_order"
export const HOME_HIDDEN_KEY = "sections_hidden"

export const THEME_PAGES: ThemePage[] = [
  {
    id: "home", title: "Home page", path: "/",
    sections: [
      home("hero", "Banner", [
        { id: "hero_image_desktop", def: "bb26-hero-poster-desktop.jpg", label: "Banner picture (computer)", type: "image", help: "Wide picture, about 2400 × 1300. With no banner video, this picture is shown instead of the video." },
        { id: "hero_image_mobile", def: "bb26-hero-poster-mobile.jpg", label: "Banner picture (phone)", type: "image", help: "Tall picture, about 1080 × 1600. Leave empty to use the computer picture." },
        { id: "hero_video_desktop", def: "bb26-hero-desktop.mp4", label: "Banner video (computer)", type: "video", help: "Optional MP4, plays silently on a loop. The picture shows while it loads." },
        { id: "hero_video_mobile", def: "bb26-hero-mobile.mp4", label: "Banner video (phone)", type: "video" },
        { id: "hero_kicker", label: "Small line above the title", type: "text", placeholder: "Autumn 2026" },
        { id: "hero_title", label: "Title", type: "text", placeholder: "The Veyron Collection" },
        { id: "hero_button", label: "Button text", type: "text", placeholder: "Discover" },
        { id: "hero_link", label: "Button link", type: "url", placeholder: "/collections/veyron" },
      ], "The big picture or video at the top of the home page."),
      home("categories", "Category tiles", [
        { id: "tile1_image", def: "bb26-tile-loafers.jpg", label: "Tile 1 picture", type: "image" },
        { id: "tile1_title", label: "Tile 1 name", type: "text", placeholder: "Loafers" },
        { id: "tile1_link", label: "Tile 1 link", type: "url", placeholder: "/collections/mens-loafers-mules" },
        { id: "tile2_image", def: "bb26-tile-sneakers.jpg", label: "Tile 2 picture", type: "image" },
        { id: "tile2_title", label: "Tile 2 name", type: "text", placeholder: "Sneakers" },
        { id: "tile2_link", label: "Tile 2 link", type: "url", placeholder: "/collections/sneakers" },
        { id: "tile3_image", def: "bb26-tile-sandals.jpg", label: "Tile 3 picture", type: "image" },
        { id: "tile3_title", label: "Tile 3 name", type: "text", placeholder: "Sandals" },
        { id: "tile3_link", label: "Tile 3 link", type: "url", placeholder: "/collections/sandals" },
        { id: "tile4_image", def: "bb26-tile-boots.jpg", label: "Tile 4 picture", type: "image" },
        { id: "tile4_title", label: "Tile 4 name", type: "text", placeholder: "Boots & Hiking" },
        { id: "tile4_link", label: "Tile 4 link", type: "url", placeholder: "/collections/boot" },
        { id: "tile5_image", def: "bb26-tile-preorder.jpg", label: "Pre-order tile picture (computer)", type: "image" },
        { id: "tile5_image_mobile", def: "bb26-tile-preorder-wide.jpg", label: "Pre-order tile picture (phone, wide)", type: "image" },
        { id: "tile5_title", label: "Pre-order tile name", type: "text", placeholder: "Pre-Order" },
        { id: "tile5_text", label: "Pre-order tile small line", type: "text", placeholder: "Book with Tk 500 · arrives in 15–20 days" },
        { id: "tile5_link", label: "Pre-order tile link", type: "url", placeholder: "/collections/pre-order" },
      ], "Five picture tiles under the banner. Pictures look best upright (3 × 4)."),
      home("new", "New In row", [
        { id: "new_collection", label: "Collection", type: "collection", placeholder: "new-arrivals" },
      ], "A sliding row of the newest products. Hidden by itself when the collection is empty."),
      home("editions", "Two feature cards", [
        { id: "edit1_image", def: "bb26-edit-leather.jpg", label: "Card 1 picture", type: "image" },
        { id: "edit1_title", label: "Card 1 title", type: "text", placeholder: "Genuine Leather Edition" },
        { id: "edit1_text", label: "Card 1 text", type: "textarea", placeholder: "Real leather, finished in Bangladesh. Sandals, loafers and boots that soften with wear, with a four-month written warranty." },
        { id: "edit1_button", label: "Card 1 button", type: "text", placeholder: "Shop the edition" },
        { id: "edit1_link", label: "Card 1 link", type: "url", placeholder: "/collections/genuine-leather" },
        { id: "edit2_image", def: "bb26-edit-combo.jpg", label: "Card 2 picture", type: "image" },
        { id: "edit2_title", label: "Card 2 title", type: "text", placeholder: "New In" },
        { id: "edit2_text", label: "Card 2 text", type: "textarea", placeholder: "The newest pairs from BlackBole. Sneakers, sandals and loafers, made in Bangladesh for every street in it." },
        { id: "edit2_button", label: "Card 2 button", type: "text", placeholder: "Shop new in" },
        { id: "edit2_link", label: "Card 2 link", type: "url", placeholder: "/collections/new-arrivals" },
      ]),
      home("craft", "Behind the craft (video)", [
        { id: "craft_video", def: "bb26-craft-real.mp4", label: "Video", type: "video" },
        { id: "craft_image", def: "bb26-craft-real-poster.jpg", label: "Picture shown before the video plays", type: "image" },
        { id: "craft_title", label: "Title", type: "text", placeholder: "Behind the Craft" },
        { id: "craft_text", label: "Text", type: "textarea", placeholder: "Cut, stitched, lasted and finished in Bangladesh. Every BlackBole pair, from the first cut to the box." },
      ]),
      home("partners", "Partner factory (video)", [
        { id: "partners_video", def: "bb26-cn-factory-v2.mp4", label: "Video", type: "video" },
        { id: "partners_image", def: "bb26-cn-factory-v2-poster.jpg", label: "Picture shown before the video plays", type: "image" },
      ]),
      home("best", "Best Sellers row", [
        { id: "best_collection", label: "Collection", type: "collection", placeholder: "best-sellers" },
      ], "Three best-selling products. Hidden by itself when the collection is empty."),
      home("promise", "Our promise", [], "Delivery, cash on delivery and free size exchange."),
      home("leather", "Leather test", [], "The interactive “press it” leather guide."),
      home("accessories", "Accessories", [], "Watches, belts and accessories tiles."),
      home("stores", "Our stores", [
        { id: "store1_address", label: "Chattogram address", type: "text", placeholder: "Prelegant Mall, CPDL Menage, 42-43 Jamal Khan Rd, Chattogram" },
        { id: "store1_map", label: "Chattogram map link", type: "url" },
        { id: "store2_address", label: "Dhaka address", type: "text", placeholder: "House 31, Road 15, Sector 14, Uttara, Dhaka" },
        { id: "store2_map", label: "Dhaka map link", type: "url" },
        { id: "hours", label: "Opening hours", type: "text", placeholder: "Open daily, 10 AM – 10 PM" },
      ]),
    ],
  },
  {
    id: "product", title: "Product page", path: "/products/", note: "Applies to every product page.",
    sections: [
      { id: "main", title: "Product details", template: "product", section: "main", fields: [
        { id: "pair_collection", label: "“Pair it with” collection", type: "collection", help: "Up to three products from this collection under the buy buttons. Empty: no “Pair it with” row." },
        { id: "pre_booking", label: "Pre-order booking money (Tk)", type: "number", placeholder: "500", min: 0 },
        { id: "advance_code", label: "Pay in advance: discount code", type: "text", placeholder: "ADVANCE5", help: "Create this code in Website → Discounts." },
        { id: "advance_pct", label: "Pay in advance: saving shown (%)", type: "number", placeholder: "5", min: 1, max: 20 },
        { id: "other_brands", label: "Other brands we stock", type: "textarea", live: false, help: "Comma separated. Products with these words in the title don't get the BlackBole story." },
      ] },
      { id: "explore", title: "Explore & combo", template: "product", section: "explore", fields: EXPLORE() },
    ],
  },
  {
    id: "collection", title: "Collection page", path: "/collections/", note: "Applies to every collection page except Pre-Order.",
    sections: [
      { id: "main", title: "Header pictures", template: "collection", section: "main", fields: [
        { id: "hero_map", label: "Header pictures by collection", type: "heromap", help: "Up to two pictures at the top of a collection. Collections not listed use their own picture." },
      ] },
      { id: "explore", title: "Explore & combo", template: "collection", section: "explore", fields: EXPLORE() },
    ],
  },
  {
    id: "preorder", title: "Pre-Order page", path: "/collections/pre-order",
    sections: [
      { id: "main", title: "Pre-Order header", template: "collection.pre-order", section: "main", fields: [
        { id: "title", label: "Page title", type: "text", placeholder: "Pre-Order" },
        { id: "hero_image", label: "Header picture", type: "image", help: "Leave empty to use the Pre-Order collection's picture." },
        { id: "days_min", label: "Delivery from (days)", type: "number", placeholder: "15", min: 1 },
        { id: "days_max", label: "Delivery up to (days)", type: "number", placeholder: "20", min: 1 },
      ] },
    ],
  },
]

function EXPLORE(): ThemeField[] {
  return [
    { id: "men", label: "Men tiles", type: "tiles", help: "Collections shown under “Explore · Men” (up to 6)." },
    { id: "women", label: "Women tiles", type: "tiles", help: "Collections shown under “Explore · Women” (up to 6)." },
    { id: "combo_collection", label: "Combo collection", type: "collection" },
    { id: "combo_kicker", label: "Combo small line", type: "text", placeholder: "The Street Combo" },
    { id: "combo_title", label: "Combo title", type: "text", placeholder: "Two pairs. One price." },
    { id: "combo_text", label: "Combo text", type: "textarea", placeholder: "Add a second pair for the days this one rests. Sneakers, sandals and loafers, made for every street in Bangladesh." },
    { id: "combo_button", label: "Combo button", type: "text", placeholder: "Build your combo" },
  ]
}

/** The website's built-in collection header pictures (pages/collections/[handle].astro). */
export const HEROMAP_DEFAULT = "mens-sandals:bb26-cat-sandals-1.jpg\nsandals:bb26-cat-sandals-1.jpg\nmens-sneakers:bb26-cat-sneakers-1.jpg,bb26-cat-sneakers-2.jpg\nsneakers:bb26-cat-sneakers-1.jpg,bb26-cat-sneakers-2.jpg\nmens-loafers-mules:bb26-cat-loafers-1.jpg,bb26-cat-loafers-2.jpg\ncasual-collection:bb26-cat-loafers-1.jpg,bb26-cat-loafers-2.jpg\nmens-boots:5_2d125c07-f3c1-4f0f-8b69-b934c4d7b9bb.jpg,mens-genuine-leather-biking-boot-1561376.jpg\nboot:5_2d125c07-f3c1-4f0f-8b69-b934c4d7b9bb.jpg,mens-genuine-leather-biking-boot-1561376.jpg\nhiking-shoes:2_bce3d4a5-eb95-480e-a78f-a7e631aecb1f.jpg,5_e0756e73-d809-4c13-9a66-f1f212f4f9c1.jpg\nhiking-collection:2_bce3d4a5-eb95-480e-a78f-a7e631aecb1f.jpg,5_e0756e73-d809-4c13-9a66-f1f212f4f9c1.jpg\ngenuine-leather:4_3515484f-d64d-4489-8bb5-144ea0634869.jpg,20_a5f2c487-fd87-447c-88ad-7cf749369b2e.jpg\nnew-arrivals:45_0d14ba02-94d1-4165-8aec-7b53b5c43ff6.jpg,11_ad076eb4-2a28-4a7e-998e-3ca310abb91a.jpg\nbest-sellers:16_cf262488-a242-42ef-b401-44fd90e9ecd3.jpg,6_565dbe0d-3c5d-40ff-a5f8-44f48076ca9f.jpg\nmen:bb26-cat-men-1.jpg\nmens-shoes:14_6bb319cd-86b2-42c1-99c2-012558bc5f21.jpg,3_1261397c-75b8-429d-9c19-c50d414730fc.jpg\nall-shoes:bb26-story-real1.jpg,16_cf262488-a242-42ef-b401-44fd90e9ecd3.jpg"

export const TILE_DEFAULTS: Record<string, string> = {
  men: "mens-sandals:Sandals,mens-sneakers:Sneakers,mens-loafers-mules:Loafers,mens-boots:Boots,watches:Watches,vincero-belts:Belts",
  women: "womens-shoes:Shoes,womens-dresses:Dresses,womens-tops-sets:Tops & sets,bags:Bags",
}

// ---------- reading / writing theme data ----------
export type ThemeData = { settings: any; templates: Record<string, any> }

export function getSettings(d: ThemeData, template: string, section: string): Record<string, any> {
  return d.templates?.[template]?.sections?.[section]?.settings ?? {}
}

/** Returns a copy of the theme with one setting changed. Empty values are removed (= website default). */
export function setSetting(d: ThemeData, template: string, section: string, key: string, value: any): ThemeData {
  const next: ThemeData = { settings: d.settings, templates: { ...d.templates } }
  const tpl = { ...(next.templates[template] ?? { sections: {}, order: [] }) }
  const sections = { ...(tpl.sections ?? {}) }
  const sec = { ...(sections[section] ?? { type: defaultType(template, section), settings: {} }) }
  const settings = { ...(sec.settings ?? {}) }
  const empty = value == null || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0)
  if (empty) delete settings[key]
  else settings[key] = value
  sec.settings = settings
  sections[section] = sec
  tpl.sections = sections
  if (!Array.isArray(tpl.order)) tpl.order = Object.keys(sections)
  else if (!tpl.order.includes(section)) tpl.order = [...tpl.order, section]
  next.templates[template] = tpl
  return next
}

function defaultType(template: string, section: string) {
  if (section === "explore") return "bb26-explore"
  if (template === "index") return "bb26-home"
  if (template === "collection.pre-order") return "bb26-preorder"
  return `bb26-${template.split(".")[0]}`
}

const listOf = (v: any): string[] => (Array.isArray(v) ? v : String(v ?? "").split(",")).map((x) => String(x).trim()).filter(Boolean)

/** The home sections in the order the website shows them, with hidden ones flagged. */
export function homeLayout(d: ThemeData) {
  const ids = THEME_PAGES[0].sections.map((s) => s.id)
  const s = getSettings(d, "index", "home")
  const want = listOf(s[HOME_ORDER_KEY]).filter((k) => ids.includes(k))
  const order = [...want, ...ids.filter((k) => !want.includes(k))]
  const hidden = new Set(listOf(s[HOME_HIDDEN_KEY]))
  return order.map((id) => ({ id, hidden: hidden.has(id) }))
}

export function setHomeLayout(d: ThemeData, layout: { id: string; hidden: boolean }[]): ThemeData {
  const ids = THEME_PAGES[0].sections.map((s) => s.id)
  const order = layout.map((x) => x.id)
  const isDefault = order.every((k, i) => k === ids[i])
  let next = setSetting(d, "index", "home", HOME_ORDER_KEY, isDefault ? null : order)
  next = setSetting(next, "index", "home", HOME_HIDDEN_KEY, layout.filter((x) => x.hidden).map((x) => x.id))
  return next
}

// "handle:Label,handle:Label"
export const parseTiles = (v: string) => listOf(v).map((e) => { const i = e.indexOf(":"); return i > 0 ? { handle: e.slice(0, i).trim(), label: e.slice(i + 1).trim() } : { handle: e.trim(), label: "" } })
export const formatTiles = (rows: { handle: string; label: string }[]) => rows.filter((r) => r.handle.trim()).map((r) => `${r.handle.trim()}:${(r.label || r.handle).replace(/[,:]/g, " ").trim()}`).join(",")

// "handle:file1,file2" one per line
export const parseHeroMap = (v: string) => String(v ?? "").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
  const i = l.indexOf(":")
  return i > 0 ? { handle: l.slice(0, i).trim(), files: l.slice(i + 1).split(",").map((x) => x.trim()).filter(Boolean).slice(0, 2) } : { handle: l, files: [] as string[] }
})
export const formatHeroMap = (rows: { handle: string; files: string[] }[]) => rows.filter((r) => r.handle.trim()).map((r) => `${r.handle.trim()}:${r.files.filter(Boolean).slice(0, 2).join(",")}`).join("\n")

// ---------- theme settings (global, Shopify's "Theme settings") ----------
// Only what the website really reads: the colours (blackbole-storefront src/lib/theme-vars.js → CSS variables).
// Stored in the theme's global settings next to the old Shopify ones (settings.current). Empty = the built-in colour.
// Logo, favicon and fonts are fixed in the website's code; the announcement bar and contact details are in
// Website → Settings.
export type ThemeSettingsGroup = { id: string; title: string; help?: string; fields: ThemeField[] }
const color = (id: string, label: string, placeholder: string, help?: string): ThemeField => ({ id, label, type: "color", placeholder, help })
export const THEME_SETTINGS: ThemeSettingsGroup[] = [
  { id: "colors", title: "Colours", help: "Every page except the home page's own sections.", fields: [
    color("bb_color_bg", "Background", "#FBF9F4"),
    color("bb_color_tile", "Picture and panel background", "#F1EDE4", "Behind product photos, the announcement bar and soft panels."),
    color("bb_color_text", "Text and buttons", "#1C1915"),
    color("bb_color_text2", "Secondary text", "#6F6A61"),
    color("bb_color_line", "Lines and borders", "#E4DFD4"),
    color("bb_color_band", "Dark band", "#211A15", "The combo band on product and collection pages."),
    color("bb_color_band_text", "Dark band text", "#EEE8DD"),
  ] },
  { id: "home_colors", title: "Home page colours", help: "The home page sections have their own, brighter palette.", fields: [
    color("bb_home_bg", "Background", "#FFFFFF"),
    color("bb_home_bg2", "Second background", "#F4F2EE", "Behind “Our promise” and the leather test."),
    color("bb_home_text", "Text and buttons", "#121110"),
    color("bb_home_text2", "Secondary text", "#6E6A63"),
    color("bb_home_line", "Lines and borders", "#E3DFD8"),
    color("bb_home_dark", "Dark labels", "#161512"),
    color("bb_home_dark_text", "Dark label text", "#E9E4DA"),
  ] },
]
export const THEME_SETTING_FIELDS = THEME_SETTINGS.flatMap((g) => g.fields)
export const isHexColor = (v: unknown) => typeof v === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v.trim())

/** The theme's global settings (Shopify keeps them under settings.current). */
export function getGlobals(d: ThemeData): Record<string, any> {
  const s = d.settings ?? {}
  return s.current && typeof s.current === "object" && !Array.isArray(s.current) ? s.current : s
}

/** Returns a copy of the theme with one global setting changed. Empty values are removed (= website default). */
export function setGlobal(d: ThemeData, key: string, value: any): ThemeData {
  const s = d.settings ?? {}
  const nested = s.current && typeof s.current === "object" && !Array.isArray(s.current)
  const g = { ...(nested ? s.current : s) }
  if (value == null || (typeof value === "string" && value.trim() === "")) delete g[key]
  else g[key] = value
  return { ...d, settings: nested ? { ...s, current: g } : g }
}

// ---------- what the editor sends to the preview page (public/js/bb-editor.js on the website) ----------
export function previewMessage(page: ThemePage, d: ThemeData, selected: string | null, inspector: boolean) {
  const values: Record<string, any> = {}
  for (const sec of page.sections) Object.assign(values, getSettings(d, sec.template, sec.section))
  const g = getGlobals(d)
  const globals: Record<string, string> = {}
  for (const f of THEME_SETTING_FIELDS) globals[f.id] = isHexColor(g[f.id]) ? String(g[f.id]).trim() : f.placeholder ?? ""
  return {
    type: "bb:theme" as const,
    sections: page.sections.map((x) => ({
      id: x.id, title: x.title,
      fields: x.live === false ? [] : x.fields.filter((f) => f.live !== false).map((f) => ({
        id: f.id, type: f.type, def: f.def ?? "",
        // tiles and header pictures: the website's built-in list stands in for an empty field
        placeholder: f.placeholder ?? (f.type === "tiles" ? TILE_DEFAULTS[f.id] ?? "" : f.type === "heromap" ? HEROMAP_DEFAULT : ""),
      })),
    })),
    values,
    globals,
    layout: page.id === "home" ? homeLayout(d) : [],
    selected,
    inspector,
  }
}

// ---------- undo / redo ----------
export type History<T> = { past: T[]; present: T; future: T[]; group: string | null; at: number }
export const HISTORY_LIMIT = 100
/** Typing in one field within this time is one undo step. */
export const HISTORY_GROUP_MS = 1000

export const historyInit = <T,>(present: T): History<T> => ({ past: [], present, future: [], group: null, at: 0 })

/** A new state. Changes to the same field (`group`) in quick succession merge into one undo step. */
export function historyPush<T>(h: History<T>, next: T, group: string | null = null, now = Date.now()): History<T> {
  if (next === h.present) return h
  if (group && group === h.group && now - h.at < HISTORY_GROUP_MS) return { ...h, present: next, future: [], at: now }
  return { past: [...h.past, h.present].slice(-HISTORY_LIMIT), present: next, future: [], group, at: now }
}
export function historyUndo<T>(h: History<T>): History<T> {
  if (!h.past.length) return h
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future], group: null, at: 0 }
}
export function historyRedo<T>(h: History<T>): History<T> {
  if (!h.future.length) return h
  return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1), group: null, at: 0 }
}

/** A file name from the old Shopify theme ("bb26-tile.jpg") or a full link → something an <img> can show. */
export function previewSrc(v: string, site: string) {
  if (!v) return ""
  if (/^https?:\/\//.test(v)) return v
  if (v.startsWith("bb26-")) return `${site}/assets/files/${v}`
  return `https://cdn.shopify.com/s/files/1/0648/0507/7129/files/${v}`
}
