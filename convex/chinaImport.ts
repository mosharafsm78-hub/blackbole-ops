/** One-off bulk upload of China pre-order shoes read from Alibaba product pages.
 *  1. The Alibaba tab posts the raw product data to /import/stage (inert: it is only stored).
 *  2. A signed-in manager runs `run` from Ops: it builds each product (BlackBole name, price, colours, sizes, pictures),
 *     creates it on Shopify as a China pre-order (booking Tk 200, full price crossed out) and adds it to Ops with fake pairs. */
import { v, ConvexError } from "convex/values"
import { action, httpAction, internalMutation, internalQuery } from "./_generated/server"
import { internal } from "./_generated/api"
import { shopifyGql } from "./shopifyStock"
import { requirePerm } from "./lib"
import { applyTestStock } from "./stockCheck"

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }

export const USD_TO_BDT = 127
export const MARKUP = 3
export const FREIGHT = 750
export const BOOKING = 200
export const FAKE_PAIRS = 10
export const STANDARD_SIZES = ["40", "41", "42", "43", "44"]
const ONLINE_STORE = "gid://shopify/Publication/133467144329"

/** Our price: Alibaba price (small-order tier, the highest) × 127 = taka cost; × 3; + Tk 750 freight per pair. */
export function priceOf(usd: number, markup = MARKUP) {
  return Math.round(usd * USD_TO_BDT * markup + FREIGHT)
}
export function costOf(usd: number) {
  return Math.round(usd * USD_TO_BDT + FREIGHT)
}

const COLOURS = ["sky blue", "dark brown", "black", "white", "grey", "gray", "blue", "green", "khaki", "beige", "brown", "red", "orange", "yellow", "camel", "silver", "tan", "navy", "pink", "purple", "cream"]
const CODE: Record<string, string> = { black: "BK", white: "WH", grey: "GR", blue: "BL", "sky blue": "SB", green: "GN", khaki: "KH", beige: "BG", brown: "BR", "dark brown": "DB", red: "RD", orange: "OR", yellow: "YL", camel: "CM", silver: "SV", tan: "TN", navy: "NV", pink: "PK", purple: "PU", cream: "CR" }
const title = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase())

/** "H6001 black" → Black, "3300 white blue" → White/Blue, "By007-1 black with fleece lining" → Black Fleece-Lined. Null when no colour word. */
export function cleanColour(raw: string): { name: string; code: string } | null {
  let s = ` ${raw.toLowerCase().replace(/gray/g, "grey")} `
  const found: string[] = []
  while (true) {
    let best: { c: string; i: number } | null = null
    for (const c of COLOURS) {
      const i = s.indexOf(c)
      if (i >= 0 && (!best || i < best.i || (i === best.i && c.length > best.c.length))) best = { c, i }
    }
    if (!best) break
    const c = best.c === "gray" ? "grey" : best.c
    if (!found.includes(c)) found.push(c)
    s = s.slice(0, best.i) + " ".repeat(best.c.length) + s.slice(best.i + best.c.length)
  }
  if (!found.length) return null
  const low = raw.toLowerCase()
  const suffix = /velvet/.test(low) ? " Velvet-Lined" : /fleece/.test(low) ? " Fleece-Lined" : ""
  return {
    name: found.map(title).join("/") + suffix,
    code: (found.length === 1 ? CODE[found[0]] : found.map((c) => CODE[c][0]).join("").slice(0, 2)) + (suffix ? "F" : ""),
  }
}

const WORDS: Record<string, number> = { "thirty-nine": 39, forty: 40, "forty-one": 41, "forty-two": 42, "forty-three": 43, "forty-four": 44, "forty-five": 45, "forty-six": 46 }
/** Men's EU sizes 39–46. "39-44" alone means every size in that range; "40-41" style pairs (sandals) stay as pairs. */
export function cleanSizes(raw: string[]): string[] {
  const out: { label: string; n: number }[] = []
  const vals = raw.map((r) => r.trim().toLowerCase())
  for (const r0 of vals) {
    const eu = /eur?\s*(\d{2})/i.exec(r0)
    const r = eu ? eu[1] : r0
    const word = WORDS[r]
    const m = /^(\d{2})\s*-\s*(\d{2})$/.exec(r)
    if (word) out.push({ label: String(word), n: word })
    else if (/^\d{2}$/.test(r)) out.push({ label: r, n: Number(r) })
    else if (m) {
      const a = Number(m[1]), b = Number(m[2])
      if (b - a === 1) out.push({ label: `${a}-${b}`, n: a })
      else if (vals.length === 1) for (let n = a; n <= b; n++) out.push({ label: String(n), n })
    }
  }
  const keep = out.filter((x) => x.n >= 39 && x.n <= 46)
  return [...new Map(keep.sort((a, b) => a.n - b.n).map((x) => [x.label, x.label])).values()]
}

export function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

/** BlackBole name, website product type and, where Alibaba's own data needs it, fixes. Keyed by Alibaba product id. */
type Meta = { t: string; type: string; boot?: boolean; colours?: string[]; keep?: number[]; skip?: string }
export const META: Record<string, Meta> = {
  "1601700105007": { t: "Slip-On Work Sneaker", type: "Casual Shoes" },
  "1602019365011": { t: "AirMesh Lace-Up Sneaker", type: "Sneakers" },
  "1601740662952": { t: "Frosted Low Winter Sneaker", type: "Casual Shoes" },
  "1602014332747": { t: "Waterproof High-Top Sneaker", type: "Sneakers" },
  "1602010201465": { t: "Clean Line Everyday Sneaker", type: "Sneakers" },
  "1602010201466": { t: "Velocity Mesh Runner", type: "Sneakers" },
  "1602010228292": { t: "Trail Utility Sneaker", type: "Sneakers" },
  "1602010149756": { t: "Chunky Comfort Casual", type: "Casual Shoes" },
  "1602010229299": { t: "Street Walker Sneaker", type: "Sneakers" },
  "1602010132912": { t: "Retro Dad Sneaker", type: "Sneakers" },
  "1602010224351": { t: "Mid Utility Boot", type: "Boots", boot: true },
  "1602010267043": { t: "Contrast Panel Sneaker", type: "Sneakers" },
  "1602010126890": { t: "Woven Mesh Lift Sneaker", type: "Sneakers" },
  "1602010113982": { t: "Stripe Runner Lift", type: "Sneakers" },
  "1602010115953": { t: "Midnight Low Sneaker", type: "Sneakers" },
  "1602010130908": { t: "Campus Court Sneaker", type: "Sneakers" },
  "1602010158676": { t: "Urban Glide Runner", type: "Sneakers" },
  "1602010230276": { t: "Seoul Skate Sneaker", type: "Sneakers" },
  "1602010245181": { t: "Block Sole Dad Sneaker", type: "Sneakers" },
  "1602010159675": { t: "Light Step Low Sneaker", type: "Sneakers" },
  "1602010149761": { t: "Classic Skate Sneaker", type: "Sneakers" },
  "1602010217383": { t: "Cloud Chunky Runner", type: "Sneakers" },
  "1602010199478": { t: "Two-Tone Skate Lift", type: "Sneakers" },
  "1602010188531": { t: "Easy Canvas Slip-On", type: "Canvas Shoes" },
  "1602010138867": { t: "Ridge Mesh Hiker", type: "Hiking Shoes" },
  "1602010135873": { t: "Fleece-Lined Lace Boot", type: "Boots", boot: true },
  "1602010184547": { t: "Contrast Court Sneaker", type: "Sneakers" },
  "1602010239255": { t: "Rugged High-Top Boot", type: "Boots", boot: true },
  "1602010140784": { t: "Soft Step Lace-Up", type: "Casual Shoes" },
  "1602010167701": { t: "Street Chunky Runner", type: "Sneakers" },
  "1602010249178": { t: "Work Day Sneaker", type: "Sneakers" },
  "1602010155686": { t: "Shadow Slip-On Sneaker", type: "Sneakers" },
  "1602010238234": { t: "Colour Block Trail Sneaker", type: "Sneakers" },
  "1602010143769": { t: "Velocity Dad Sneaker", type: "Sneakers" },
  "1602010263046": { t: "Breeze Mesh Dad Sneaker", type: "Sneakers", colours: ["Black"] },
  "1602010239218": { t: "Summer Soft-Sole Sneaker", type: "Sneakers" },
  "1601820456645": { t: "Turf Pro High-Top Boot", type: "Football Boots", keep: [1, 2, 3, 4] },
  "1602007252631": { t: "Fleece Trek Boot", type: "Boots", boot: true },
  "1601671622542": { t: "Retro Runner Classic", type: "Sneakers" },
  "1602007413120": { t: "Winter Cushion Dad Shoe", type: "Sneakers" },
  "1601700524633": { t: "Tri-Tone Platform Sneaker", type: "Sneakers" },
  "1601700531572": { t: "Two-Tone Chunky Sneaker", type: "Sneakers" },
  "1601672832043": { t: "Stripe Mesh Walker", type: "Sneakers" },
  "1601823704970": { t: "Suede Mesh Runner", type: "Sneakers" },
  "1601696729606": { t: "Hip-Hop Colour Block Sneaker", type: "Sneakers" },
  "1601700029492": { t: "Twist-Lock Work Sneaker", type: "Sneakers" },
  "1601700464937": { t: "Platform Utility Sneaker", type: "Sneakers" },
  "1601700006627": { t: "Easy Fabric Slip-On", type: "Casual Shoes" },
  "1601700589197": { t: "Gradient Lace-Up Sneaker", type: "Sneakers" },
  "1601699998661": { t: "Colour Block Platform Shoe", type: "Casual Shoes" },
  "1601699615008": { t: "Perforated Support Runner", type: "Sneakers" },
  "1601695126497": { t: "Hook-Loop Sport Sandal", type: "Sandals" },
  "1601695183329": { t: "Summer Mesh Lift Runner", type: "Sneakers" },
  "1601695089522": { t: "Bold Colour Casual Sneaker", type: "Sneakers" },
  "1601834204060": { t: "Buckle Slide Sandal", type: "Sandals" },
  "1601801012205": { t: "Canvas Beach Sandal", type: "Sandals" },
  "1601742042749": { t: "Closed-Toe Water Sandal", type: "Sandals" },
  "1601700466911": { t: "Everyday Lift Sneaker", type: "Sneakers" },
  "1601700459962": { t: "Closed-Toe Beach Clog", type: "Sandals" },
  "1601700014588": { t: "Light Mesh Trend Runner", type: "Sneakers" },
  "1601700581185": { t: "British Leather Work Boot", type: "Boots", boot: true },
  "1601699465883": { t: "Steel Toe Safety Sneaker", type: "Safety Shoes" },
  "1601695878553": { t: "Mesh Platform Trend Sneaker", type: "Sneakers" },
  "1601997684572": { t: "Big Toe Trail Hiker", type: "Hiking Shoes" },
  "1601994653920": { t: "Soft Sole Low Lace-Up", type: "Casual Shoes" },
  "1601674787573": { t: "Mesh Student Sneaker", type: "Sneakers", skip: "only small sizes (35–40)" },
  "1601983508082": { t: "Breeze Walk Lace-Up", type: "Casual Shoes" },
  "1601983469375": { t: "Field Casual Lace-Up", type: "Casual Shoes" },
  "1601983460534": { t: "Patterned Casual Lace-Up", type: "Casual Shoes" },
  "1601983528326": { t: "Suede Platform Casual", type: "Casual Shoes" },
  "1601983546004": { t: "Chunky Mesh Casual", type: "Casual Shoes" },
  "1601983483422": { t: "Court Lace-Up Sneaker", type: "Sneakers" },
  "1601983424858": { t: "Khaki Everyday Lace-Up", type: "Casual Shoes" },
  "1601984482712": { t: "Mesh-Lined City Lace-Up", type: "Casual Shoes" },
  "1601984560596": { t: "Fabric Pull-Tab Loafer", type: "Loafers" },
  "1601984561565": { t: "City Lace-Up Casual", type: "Casual Shoes" },
  "1601984643088": { t: "Pull-Tab Grey Lace-Up", type: "Casual Shoes" },
  "1601984499894": { t: "Mesh Slip-On Walker", type: "Casual Shoes" },
  "1601984562248": { t: "Panelled Low Casual", type: "Casual Shoes" },
  "1601984613508": { t: "Panelled Pull-Tab Casual", type: "Casual Shoes" },
  "1601984546938": { t: "Retro Red-Blue Lace-Up", type: "Casual Shoes" },
  "1601984617432": { t: "Knit Slip-On Casual", type: "Casual Shoes" },
  "1601984651161": { t: "Canvas Gusset Slip-On", type: "Canvas Shoes" },
  "1601984587682": { t: "Beige Comfort Lace-Up", type: "Casual Shoes" },
  "1601984839258": { t: "Apron Toe Casual", type: "Casual Shoes" },
  "1601984829374": { t: "Two-Tone Leather-Look Lace-Up", type: "Casual Shoes" },
  "1601987854137": { t: "Suede Walker Lace-Up", type: "Casual Shoes" },
  "1601987763880": { t: "Cotton-Lined Slip-On", type: "Casual Shoes" },
  "1601987841476": { t: "Mid-Top Chunky Casual", type: "Casual Shoes" },
  "1601700579191": { t: "Korean Flat Lace-Up", type: "Casual Shoes" },
  "1601990193736": { t: "Vintage Mesh Runner", type: "Sneakers" },
  "1601984592639": { t: "Black Classic Lace-Up", type: "Casual Shoes" },
  "1601984551878": { t: "Beige-Black Casual Lace-Up", type: "Casual Shoes" },
  "1601982024846": { t: "Athletic Chunky Dad Sneaker", type: "Sneakers" },
  "1601980975627": { t: "Closed-Toe Safety Sneaker", type: "Safety Shoes" },
  "1601700029494": { t: "Colour Match Soft Runner", type: "Sneakers" },
  "1601871759932": { t: "Twist-Lace Trail Runner", type: "Sneakers" },
  "1601840883010": { t: "Leather Dad Runner", type: "Sneakers" },
  "1601777384336": { t: "High-Top Street Sneaker", type: "Sneakers" },
  "1601670961550": { t: "Mid-Calf Slip-On Boot", type: "Boots", boot: true },
  "1601766536898": { t: "Mesh Safety Work Shoe", type: "Safety Shoes" },
  "1601780479054": { t: "Black Chunky Work Sneaker", type: "Sneakers" },
  "1601740887377": { t: "Cross-Country Trail Hiker", type: "Hiking Shoes" },
  "1601671782296": { t: "High-Top Work Sneaker", type: "Sneakers" },
  "1601964037757": { t: "Spring-Back Light Runner", type: "Sneakers" },
  "1601964039812": { t: "Easy Mesh Sneaker", type: "Sneakers" },
  "1601961507539": { t: "Platform Canvas Skate Shoe", type: "Canvas Shoes" },
  "1601960987672": { t: "Retro Pattern Platform Plimsoll", type: "Sneakers" },
  "1601741972528": { t: "Leather Trek Sandal", type: "Sandals" },
  "1601954583029": { t: "British Mid-Calf Work Boot", type: "Boots", boot: true },
  "1601928800973": { t: "Two-Way Beach Sandal", type: "Sandals" },
  "1601675642049": { t: "Velvet-Lined Buckle Boot", type: "Boots", boot: true },
  "1601700004652": { t: "British Retro Skate Sneaker", type: "Sneakers" },
  "1601700503684": { t: "Bold Sole Fashion Sneaker", type: "Sneakers" },
  "1601845337253": { t: "Moto High-Top Boot", type: "Boots", boot: true },
  "1601758707715": { t: "Cushion Walk Dad Sneaker", type: "Sneakers" },
  "1601823814536": { t: "Leather-Look Sport Sneaker", type: "Sneakers" },
  "1601820288806": { t: "Grip Low-Top Casual", type: "Casual Shoes" },
  "1601700597052": { t: "Campus Mesh Sneaker", type: "Sneakers" },
  "1601735275872": { t: "Tokyo Pop Sneaker", type: "Sneakers" },
  "1601933183809": { t: "High-Top Soft Walker", type: "Casual Shoes" },
  "1601929056428": { t: "Luxe Leather Lace-Up Sneaker", type: "Sneakers" },
  "1601929033326": { t: "Embossed Driving Slipper", type: "Sandals" },
  "1601928805550": { t: "Retro Platform Board Shoe", type: "Sneakers" },
  "1601700508625": { t: "Everyday Canvas Board Shoe", type: "Canvas Shoes" },
  "1601923286492": { t: "Platform High-Top Street Shoe", type: "Sneakers" },
  "1601922293736": { t: "Shiny British Loafer", type: "Loafers" },
  "1601700453955": { t: "Seoul Chunky Walker", type: "Sneakers" },
  "1601919657715": { t: "Animal Print Flat Sneaker", type: "Sneakers" },
}

const ADJ = ["Nova", "Harbor", "Summit", "Metro", "Orbit", "Vale", "Ridge", "Drift", "Arlo", "Calder", "Brook", "Aspen", "Cedar", "Echo", "Flint", "Haven", "Juno", "Kenzo", "Luca", "Milo", "Nash", "Otis", "Pike", "Quill", "Rowan", "Sable", "Tate", "Ulric", "Vance", "Wren", "Axel", "Blaze", "Colt", "Dex", "Ezra", "Finn", "Gage", "Hugo", "Ivo", "Jett", "Knox", "Leo", "Mace", "Nico", "Onyx", "Pax", "Rex", "Soren", "Theo", "Vito", "Wade", "Zane", "Alden", "Beck", "Cruz", "Dane", "Elio", "Ford", "Grey", "Hale", "Ira", "Jude", "Kai", "Lane", "Marlo", "Nolan", "Oren", "Price", "Reed", "Shaw", "Troy", "Vale", "Ward", "York", "Zeno", "Atlas", "Bryn", "Cove", "Dune", "Ember"]
const STYLES: [RegExp, string, string, boolean?][] = [
  [/dress shoe|formal|wedding|oxford|derby|business/i, "Dress Shoe", "Formal Shoes"],
  [/loafer|mocass?in|mocassin|penny|driving|boat shoe/i, "Loafer", "Loafers"],
  [/snow boot|martin|\bboots?\b/i, "Boot", "Boots", true],
  [/sandal|slipper|slides?\b|mule/i, "Sandal", "Sandals"],
  [/canvas|vulcani[sz]ed/i, "Canvas Sneaker", "Canvas Shoes"],
  [/safety|work shoe|labou?r|tooling|construction/i, "Work Sneaker", "Sneakers"],
  [/hiking|trail|mountaineering|trekking|tactical/i, "Trail Runner", "Hiking Shoes"],
  [/high.?top/i, "High-Top Sneaker", "Sneakers"],
  [/chunky|dad shoe|platform|thick.?sol|height/i, "Chunky Sneaker", "Sneakers"],
  [/skate|board shoe/i, "Skate Sneaker", "Sneakers"],
  [/running|runner|jogg|athletic|tennis|trainer/i, "Runner", "Sneakers"],
  [/slip.?on|lazy/i, "Slip-On", "Casual Shoes"],
]
/** A BlackBole-style name for products with no hand-written name: "Harbor Chunky Sneaker". */
export function autoMeta(id: string, subject: string, salt = 0): Meta {
  const st = STYLES.find(([re]) => re.test(subject)) ?? [/./, "Casual Sneaker", "Sneakers"]
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return { t: `${ADJ[(h + salt * 7) % ADJ.length]} ${st[1]}`, type: st[2], boot: !!st[3] }
}

export type Raw = { id: number; first?: string; store?: string; subject: string; ladder: [number, number, number][]; skuPrice?: number; attrs: { name: string; values: { name: string; img: string | null }[] }[]; media: string[]; props: [string, string][] }
export type Spec = {
  alibabaId: string; title: string; handle: string; type: string; boot: boolean; usd: number; price: number; cost: number
  abbr: string; colours: { name: string; code: string; img: string | null }[]; sizes: string[]; images: string[]
  descriptionHtml: string; seoTitle: string; seoDescription: string
}

function prop(r: Raw, re: RegExp) {
  const p = r.props.find(([k, val]) => re.test(k) && val && !/^none$/i.test(val.trim()))
  return p ? p[1].split(",")[0].trim() : null
}
const material = (s: string | null) => (s ? s.replace(/^pu$/i, "PU").replace(/^pvc$/i, "PVC").replace(/\bfaux leather\b/i, "faux leather").replace(/^(\w)/, (c) => c.toUpperCase()) : null)
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** Turns one Alibaba product into a BlackBole China pre-order. Throws (with a plain reason) when it can't be listed. */
export function buildSpec(r: Raw, taken?: Set<string>, markup = MARKUP): Spec {
  const id = String(r.id)
  let meta = META[id] ?? autoMeta(id, r.subject)
  for (let salt = 1; !META[id] && taken?.has(meta.t) && salt < 40; salt++) meta = autoMeta(id, r.subject, salt)
  taken?.add(meta.t)
  if (meta.skip) throw new Error(meta.skip)
  const usd = r.ladder.length ? Math.max(...r.ladder.map((l) => l[2])) : r.skuPrice ?? 0
  if (!(usd > 0)) throw new Error("Alibaba shows no price")
  const colourAttr = r.attrs.find((a) => /colou?r/i.test(a.name))
  let raw = colourAttr?.values ?? []
  if (meta.keep) raw = meta.keep.map((i) => raw[i]).filter(Boolean)
  const colours: Spec["colours"] = []
  for (const [i, c] of raw.entries()) {
    const cc = meta.colours ? (meta.colours[i] ? { name: meta.colours[i], code: cleanColour(meta.colours[i])?.code ?? "XX" } : null) : cleanColour(c.name)
    if (!cc || colours.some((x) => x.name === cc.name)) continue
    let code = cc.code
    for (let k = 2; colours.some((x) => x.code === code); k++) code = cc.code.slice(0, 2) + k
    colours.push({ name: cc.name, code, img: c.img })
  }
  if (!colours.length) throw new Error("no usable colour")
  const sizeAttrs = r.attrs.filter((a) => /size/i.test(a.name))
  // no size list on Alibaba at all: the standard men's run 40–44
  const listed = sizeAttrs.length ? cleanSizes(sizeAttrs.flatMap((a) => a.values.map((x) => x.name))) : STANDARD_SIZES
  // men's China pre-orders always come in the standard EU 40–44 (sandal pair sizes like 40-41 stay as listed)
  const sizes = listed.some((x) => x.includes("-")) ? listed : STANDARD_SIZES
  if (sizes.length < 2) throw new Error("no men's sizes")
  const images = [...new Set([...colours.map((c) => c.img).filter((x): x is string => !!x), ...r.media])].slice(0, 10)
  const t = meta.t
  const initials = t.replace(/-/g, " ").split(/\s+/).map((w) => w[0]).join("").toUpperCase().slice(0, 4)
  const abbr = `${initials}${id.slice(-3)}`
  const upper = material(prop(r, /^upper/i)), lining = material(prop(r, /^lining/i)), sole = material(prop(r, /^outsole/i))
  const closure = prop(r, /closure/i), feature = prop(r, /^feature/i)
  const kind = meta.type.replace(/s$/, "").toLowerCase().replace(/^canvas shoe$/, "canvas shoe")
  const colourList = colours.map((c) => c.name.toLowerCase())
  const colourText = colourList.length === 1 ? colourList[0] : `${colourList.slice(0, -1).join(", ")} or ${colourList[colourList.length - 1]}`
  const sizeText = sizes.length && /-/.test(sizes[0]) ? `EU ${sizes.join(", ")}` : `EU ${sizes[0]}–${sizes[sizes.length - 1]}`
  const intro = `A ${kind} built for everyday wear${upper ? `, with a ${upper.toLowerCase()} upper` : ""}${sole ? ` on a ${sole.toLowerCase()} sole` : ""}.${feature ? ` ${feature.replace(/\.$/, "").replace(/^(\w)/, (c) => c.toUpperCase())}.` : ""}`
  const li = [
    upper && `<li><strong>Upper:</strong> ${esc(upper)}</li>`,
    lining && `<li><strong>Lining:</strong> ${esc(lining)}</li>`,
    sole && `<li><strong>Sole:</strong> ${esc(sole)}</li>`,
    closure && `<li><strong>Closure:</strong> ${esc(closure)}</li>`,
    `<li><strong>Colours:</strong> ${esc(colours.map((c) => c.name).join(", "))}</li>`,
    `<li><strong>Sizes:</strong> ${sizeText}</li>`,
  ].filter(Boolean).join("")
  const descriptionHtml = `<p>${esc(intro)}</p><ul>${li}</ul><p><strong>Pre-order.</strong> Book your pair today with just Tk ${BOOKING}. It reaches you in 15 to 20 days, and you pay the rest on delivery.</p>`
  return {
    alibabaId: id, title: t, handle: slug(t), type: meta.type, boot: !!meta.boot, usd, price: priceOf(usd, markup), cost: costOf(usd), abbr, colours, sizes, images,
    descriptionHtml,
    seoTitle: `${t} for Men – Pre-Order | BlackBole`,
    seoDescription: `${t.replace(/^(\w)/, (c) => c)} in ${colourText}, ${sizeText}. Pre-order: book with Tk ${BOOKING}, pay the rest on delivery in 15–20 days.`,
  }
}

// ---------- staging (from the Alibaba tab) ----------

export const stageHttp = httpAction(async (ctx, req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS })
  const text = await req.text()
  if (text.length > 900_000) return new Response("too big", { status: 413, headers: CORS })
  let body: any
  try { body = JSON.parse(text) } catch { return new Response("bad json", { status: 400, headers: CORS }) }
  if (!/^[a-z0-9-]{3,40}$/.test(String(body.batch)) || !Number.isInteger(body.part) || body.part < 0 || body.part > 50 || typeof body.data !== "string") return new Response("bad input", { status: 400, headers: CORS })
  await ctx.runMutation(internal.dashboard.writeCache, { key: `chinaImport:${body.batch}:${body.part}`, value: body.data })
  return new Response(JSON.stringify({ ok: true, bytes: body.data.length }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } })
})

export const staged = internalQuery({
  args: { batch: v.string(), part: v.number() },
  handler: async (ctx, { batch, part }) => {
    const row = await ctx.db.query("cache").withIndex("by_key", (q) => q.eq("key", `chinaImport:${batch}:${part}`)).unique()
    return row ? (row.value as string) : null
  },
})

export const allowed = internalQuery({ args: {}, handler: async (ctx) => { await requirePerm(ctx, "products.manage"); return true } })

async function loadRaw(ctx: any, batch: string, parts: number): Promise<Raw[]> {
  const out: Raw[] = []
  for (let p = 0; p < parts; p++) {
    const s = await ctx.runQuery(internal.chinaImport.staged, { batch, part: p })
    if (!s) throw new ConvexError(`Part ${p} of ${batch} is not staged`)
    const val = JSON.parse(s)
    out.push(...(Array.isArray(val) ? val : Object.values(val)))
  }
  return out
}

// ---------- Ops side ----------

export const upsertOps = internalMutation({
  args: { handle: v.string(), title: v.string(), price: v.number(), cost: v.number(), weightKg: v.number(), image: v.optional(v.string()), variants: v.array(v.object({ sku: v.string(), title: v.string(), image: v.optional(v.string()) })) },
  handler: async (ctx, a) => {
    const now = Date.now()
    let prod = await ctx.db.query("products").withIndex("by_handle", (q) => q.eq("handle", a.handle)).first()
    if (prod?.deletedAt) prod = null
    const productId = prod?._id ?? (await ctx.db.insert("products", { name: a.title, active: true, createdAt: now, handle: a.handle, preOrder: true, preOrderFrom: "china", category: "Footwear", ...(a.image ? { imageUrl: a.image } : {}) }))
    const items: { variantId: any; qty: number }[] = []
    for (const x of a.variants) {
      const have = await ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", x.sku)).first()
      if (have) continue // already there (re-run): leave its stock alone
      const id = await ctx.db.insert("variants", { productId, sku: x.sku, title: x.title, weightKg: a.weightKg, price: a.price, purchasePrice: a.cost, active: true, createdAt: now, ...(x.image ? { imageUrl: x.image } : {}) })
      items.push({ variantId: id, qty: FAKE_PAIRS })
    }
    if (items.length) await applyTestStock(ctx, items, "System (China pre-order upload)")
    return { productId, added: items.length }
  },
})

export const setOpsPrice = internalMutation({
  args: { skus: v.array(v.string()), price: v.number() },
  handler: async (ctx, { skus, price }) => {
    for (const sku of skus) {
      const x = await ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", sku)).first()
      if (x && x.price !== price) await ctx.db.patch(x._id, { price })
    }
  },
})

// ---------- run ----------

const PRODUCT_SET = `mutation($input: ProductSetInput!) { productSet(input: $input, synchronous: true) { product { id handle } userErrors { field message } } }`
const PUBLISH = `mutation($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { message } } }`

export const run = action({
  args: { batch: v.string(), parts: v.number(), from: v.optional(v.number()), count: v.optional(v.number()), only: v.optional(v.array(v.string())), store: v.optional(v.string()), markup: v.optional(v.number()), dryRun: v.optional(v.boolean()), supplier: v.string() },
  handler: async (ctx, a) => {
    await ctx.runQuery(internal.chinaImport.allowed, {})
    const supplier = a.supplier.trim()
    if (!/^[A-Za-z][A-Za-z .'-]{1,40}$/.test(supplier)) throw new ConvexError("Supplier name looks wrong")
    const first = supplier.split(/\s+/)[0]
    let raws = await loadRaw(ctx, a.batch, a.parts)
    if (a.only?.length) raws = raws.filter((r) => a.only!.includes(String(r.id)))
    if (a.store) raws = raws.filter((r) => r.store === a.store)
    raws = raws.slice(a.from ?? 0, (a.from ?? 0) + (a.count ?? raws.length))
    const done: any[] = [], skipped: any[] = []
    const taken = new Set<string>()
    for (const r of raws) {
      let s: Spec
      try { s = buildSpec(r, taken, a.markup ?? MARKUP) } catch (e: any) { skipped.push({ id: r.id, why: e.message }); continue }
      if (a.dryRun) { done.push({ id: s.alibabaId, title: s.title, usd: s.usd, price: s.price, colours: s.colours.map((c) => `${c.name}(${c.code})`), sizes: s.sizes, images: s.images.length }); continue }
      // already uploaded (same Alibaba product) → skip; same name taken by another product → new handle
      const prev = await shopifyGql(ctx, `query($q: String!) { products(first: 5, query: $q) { nodes { id handle tags } } }`, { q: `tag:alibaba-${s.alibabaId}` })
      const sku = (c: Spec["colours"][number], size: string) => `PO-${s.abbr}-${c.code}-${size}`
      const opsArgs = (handle: string) => ({
        handle, title: s.title, price: s.price, cost: s.cost, weightKg: s.boot ? 1.2 : 0.9, image: s.images[0],
        variants: s.colours.flatMap((c) => s.sizes.map((size) => ({ sku: sku(c, size), title: `${c.name} / ${size}`, ...(c.img ? { image: c.img } : {}) }))),
      })
      if (prev.products.nodes.length) {
        // already on Shopify: only make sure Ops has it (sizes already in Ops are left alone)
        const n = prev.products.nodes[0]
        // bring the price in line (e.g. after a markup change): full price is the crossed-out compare-at price
        const vs = await shopifyGql(ctx, `query($id: ID!) { product(id: $id) { variants(first: 250) { nodes { id compareAtPrice } } } }`, { id: n.id })
        const stale = vs.product.variants.nodes.filter((x: any) => Number(x.compareAtPrice) !== s.price)
        if (stale.length) {
          const up = await shopifyGql(ctx, `mutation($pid: ID!, $v: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $pid, variants: $v) { userErrors { message } } }`, { pid: n.id, v: stale.map((x: any) => ({ id: x.id, compareAtPrice: String(s.price) })) })
          if (up.productVariantsBulkUpdate.userErrors.length) skipped.push({ id: r.id, why: `price: ${up.productVariantsBulkUpdate.userErrors[0].message}` })
        }
        await ctx.runMutation(internal.chinaImport.setOpsPrice, { skus: opsArgs(n.handle).variants.map((x) => x.sku), price: s.price })
        const ops = await ctx.runMutation(internal.chinaImport.upsertOps, opsArgs(n.handle))
        done.push({ id: s.alibabaId, title: s.title, handle: n.handle, productId: n.id, price: s.price, already: true, opsSizes: ops.added })
        continue
      }
      let handle = s.handle
      for (let k = 2; ; k++) {
        const h = await shopifyGql(ctx, `query($h: String!) { productByIdentifier(identifier: { handle: $h }) { id } }`, { h: handle })
        if (!h.productByIdentifier) break
        handle = `${s.handle}-${k}`
      }
      const variants = s.colours.flatMap((c) => s.sizes.map((size) => ({
        optionValues: [{ optionName: "Color", name: c.name }, { optionName: "Size", name: size }],
        sku: sku(c, size), price: String(BOOKING), compareAtPrice: String(s.price), inventoryPolicy: "CONTINUE",
        inventoryItem: { tracked: false, cost: String(s.cost) },
        ...(c.img ? { file: { originalSource: c.img, contentType: "IMAGE", alt: `${s.title} in ${c.name.toLowerCase()}` } } : {}),
      })))
      const input = {
        title: s.title, handle, productType: s.type, vendor: "BlackBole", status: "ACTIVE", descriptionHtml: s.descriptionHtml,
        tags: ["bb-footwear", "bb-men", "pre-order", `supplier-${slug(supplier)}`, first.toUpperCase(), `alibaba-${s.alibabaId}`],
        seo: { title: s.seoTitle, description: s.seoDescription },
        metafields: [{ namespace: "custom", key: "supplier", type: "single_line_text_field", value: supplier }],
        productOptions: [{ name: "Color", values: s.colours.map((c) => ({ name: c.name })) }, { name: "Size", values: s.sizes.map((x) => ({ name: x })) }],
        files: s.images.map((src, i) => ({ originalSource: src, contentType: "IMAGE", alt: `${s.title}, view ${i + 1}` })),
        variants,
      }
      try {
        const res = await shopifyGql(ctx, PRODUCT_SET, { input })
        const err = res.productSet.userErrors
        if (err.length || !res.productSet.product) { skipped.push({ id: r.id, why: `Shopify: ${err.map((x: any) => x.message).join("; ")}` }); continue }
        const pid = res.productSet.product.id
        // the Ops app may not be allowed to publish: then it's published to the Online Store separately
        let published = true
        try { await shopifyGql(ctx, PUBLISH, { id: pid, input: [{ publicationId: ONLINE_STORE }] }) } catch { published = false }
        const ops = await ctx.runMutation(internal.chinaImport.upsertOps, opsArgs(handle))
        done.push({ id: s.alibabaId, title: s.title, handle, productId: pid, published, price: s.price, colours: s.colours.length, sizes: s.sizes.length, opsSizes: ops.added })
      } catch (e: any) {
        skipped.push({ id: r.id, why: String(e.message ?? e).slice(0, 300) })
      }
    }
    return { done, skipped, total: raws.length }
  },
})

// ---------- fix: products Alibaba gave no size list for get the standard 40–44 (size 39 removed) ----------

export const purgeOpsSkus = internalMutation({
  args: { skus: v.array(v.string()) },
  handler: async (ctx, { skus }) => {
    let n = 0
    for (const sku of skus) {
      const x = await ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", sku)).first()
      if (!x) continue
      // a size with real pairs or real movement is only switched off, never deleted
      const stock = await ctx.db.query("stock").withIndex("by_variant", (q) => q.eq("variantId", x._id)).collect()
      const real = stock.some((r) => r.available - (r.virtual ?? 0) > 0 || r.processing > 0 || r.inTransit > 0 || r.returning > 0 || r.damaged > 0)
      const logs = await ctx.db.query("stockLogs").withIndex("by_variant", (q) => q.eq("variantId", x._id)).collect()
      const moved = logs.some((l: any) => l.reason !== "Fake stock added")
      if (real || moved) {
        await ctx.db.patch(x._id, { active: false })
        for (const r of stock) if (r.virtual) await ctx.db.patch(r._id, { available: Math.max(0, r.available - r.virtual), virtual: 0 })
        n++
        continue
      }
      for (const r of await ctx.db.query("stock").withIndex("by_variant", (q) => q.eq("variantId", x._id)).collect()) await ctx.db.delete(r._id)
      for (const r of await ctx.db.query("stockLogs").withIndex("by_variant", (q) => q.eq("variantId", x._id)).collect()) await ctx.db.delete(r._id)
      for (const r of await ctx.db.query("shopifyDirty").withIndex("by_variant", (q) => q.eq("variantId", x._id)).collect()) await ctx.db.delete(r._id)
      await ctx.db.delete(x._id)
      n++
    }
    return n
  },
})

export const standardSizesForUnsized = action({
  args: { batch: v.string(), parts: v.number(), dryRun: v.optional(v.boolean()) },
  handler: async (ctx, a) => {
    await ctx.runQuery(internal.chinaImport.allowed, {})
    const raws = (await loadRaw(ctx, a.batch, a.parts)).filter((r) => !r.attrs.some((x) => /size/i.test(x.name)))
    const out: any[] = []
    for (const r of raws) {
      const res = await shopifyGql(ctx, `query($q: String!) { products(first: 1, query: $q) { nodes { id title variants(first: 250) { nodes { id sku selectedOptions { name value } } } } } }`, { q: `tag:alibaba-${r.id}` })
      const p = res.products.nodes[0]
      if (!p) continue
      const gone = p.variants.nodes.filter((x: any) => x.selectedOptions.some((o: any) => o.name === "Size" && !STANDARD_SIZES.includes(o.value)))
      if (!gone.length) continue
      if (!a.dryRun) {
        const del = await shopifyGql(ctx, `mutation($pid: ID!, $ids: [ID!]!) { productVariantsBulkDelete(productId: $pid, variantsIds: $ids) { userErrors { message } } }`, { pid: p.id, ids: gone.map((x: any) => x.id) })
        if (del.productVariantsBulkDelete.userErrors.length) { out.push({ title: p.title, error: del.productVariantsBulkDelete.userErrors[0].message }); continue }
        await ctx.runMutation(internal.chinaImport.purgeOpsSkus, { skus: gone.map((x: any) => x.sku).filter(Boolean) })
      }
      out.push({ title: p.title, removed: gone.length })
    }
    return out
  },
})

// ---------- every Alibaba China pre-order (men's) gets exactly EU 40–44 ----------

export const addOpsSizes = internalMutation({
  args: { items: v.array(v.object({ siblingSku: v.string(), sku: v.string(), size: v.string() })) },
  handler: async (ctx, { items }) => {
    const add: { variantId: any; qty: number }[] = []
    for (const it of items) {
      if (await ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", it.sku)).first()) continue
      const sib = await ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", it.siblingSku)).first()
      if (!sib) continue
      const colour = sib.title.split(" / ")[0]
      const id = await ctx.db.insert("variants", { productId: sib.productId, sku: it.sku, title: `${colour} / ${it.size}`, weightKg: sib.weightKg, price: sib.price, purchasePrice: sib.purchasePrice, active: true, createdAt: Date.now(), ...(sib.imageUrl ? { imageUrl: sib.imageUrl } : {}) })
      const sibStock = await ctx.db.query("stock").withIndex("by_variant", (q) => q.eq("variantId", sib._id)).collect()
      const fake = sibStock.reduce((t, r) => t + (r.virtual ?? 0), 0)
      if (fake > 0) add.push({ variantId: id, qty: Math.min(fake, FAKE_PAIRS) })
    }
    if (add.length) await applyTestStock(ctx, add, "System (standard sizes 40–44)")
    return add.length
  },
})

export const standardizeSizes = action({
  args: { query: v.string(), after: v.optional(v.string()), count: v.optional(v.number()), dryRun: v.optional(v.boolean()) },
  handler: async (ctx, a) => {
    await ctx.runQuery(internal.chinaImport.allowed, {})
    const res = await shopifyGql(ctx, `query($q: String!, $n: Int!, $after: String) { products(first: $n, after: $after, query: $q) { pageInfo { hasNextPage endCursor } nodes { id title
      variants(first: 150) { nodes { id sku price compareAtPrice selectedOptions { name value } inventoryItem { unitCost { amount } } media(first: 1) { nodes { id } } } } } } }`, { q: a.query, n: a.count ?? 15, after: a.after ?? null })
    const out: any[] = []
    for (const p of res.products.nodes) {
      const sizeName = p.variants.nodes[0]?.selectedOptions.find((o: any) => /size/i.test(o.name))?.name
      const colorName = p.variants.nodes[0]?.selectedOptions.find((o: any) => /colou?r/i.test(o.name))?.name
      const others = p.variants.nodes[0]?.selectedOptions.filter((o: any) => o.name !== sizeName && o.name !== colorName) ?? []
      if (!sizeName || others.length) { out.push({ title: p.title, skipped: `options are ${p.variants.nodes[0]?.selectedOptions.map((o: any) => o.name).join(" / ")}` }); continue }
      const vs = p.variants.nodes.map((x: any) => ({ ...x, color: colorName ? x.selectedOptions.find((o: any) => o.name === colorName)?.value : null, size: x.selectedOptions.find((o: any) => o.name === sizeName)?.value }))
      const gone = vs.filter((x: any) => !STANDARD_SIZES.includes(x.size))
      const create: any[] = [], opsAdd: any[] = []
      for (const color of [...new Set(vs.map((x: any) => x.color))]) {
        const mine = vs.filter((x: any) => x.color === color)
        for (const size of STANDARD_SIZES) {
          if (mine.some((x: any) => x.size === size)) continue
          const num = (z: string) => parseInt(z) || 0
          const sib = [...mine].sort((x: any, y: any) => Math.abs(num(x.size) - +size) - Math.abs(num(y.size) - +size))[0]
          const sku = /-\d{2}(-\d{2})?$/.test(sib.sku ?? "") ? sib.sku.replace(/-\d{2}(-\d{2})?$/, `-${size}`) : `${sib.sku || "PO"}-${size}`
          create.push({
            optionValues: [...(colorName ? [{ optionName: colorName, name: color }] : []), { optionName: sizeName, name: size }],
            price: sib.price, ...(sib.compareAtPrice ? { compareAtPrice: sib.compareAtPrice } : {}), inventoryPolicy: "CONTINUE",
            inventoryItem: { sku, tracked: false, ...(sib.inventoryItem?.unitCost?.amount ? { cost: sib.inventoryItem.unitCost.amount } : {}) },
            ...(sib.media?.nodes?.[0]?.id ? { mediaId: sib.media.nodes[0].id } : {}),
          })
          opsAdd.push({ siblingSku: sib.sku, sku, size })
        }
      }
      if (!gone.length && !create.length) continue
      if (!a.dryRun) {
        if (create.length) {
          const c = await shopifyGql(ctx, `mutation($pid: ID!, $v: [ProductVariantsBulkInput!]!) { productVariantsBulkCreate(productId: $pid, variants: $v) { userErrors { message } } }`, { pid: p.id, v: create })
          if (c.productVariantsBulkCreate.userErrors.length) { out.push({ title: p.title, error: `add: ${c.productVariantsBulkCreate.userErrors[0].message}` }); continue }
          await ctx.runMutation(internal.chinaImport.addOpsSizes, { items: opsAdd })
        }
        if (gone.length) {
          const d = await shopifyGql(ctx, `mutation($pid: ID!, $ids: [ID!]!) { productVariantsBulkDelete(productId: $pid, variantsIds: $ids) { userErrors { message } } }`, { pid: p.id, ids: gone.map((x: any) => x.id) })
          if (d.productVariantsBulkDelete.userErrors.length) { out.push({ title: p.title, error: `remove: ${d.productVariantsBulkDelete.userErrors[0].message}` }); continue }
          await ctx.runMutation(internal.chinaImport.purgeOpsSkus, { skus: gone.map((x: any) => x.sku).filter(Boolean) })
        }
      }
      out.push({ title: p.title, removed: gone.map((x: any) => x.size).filter((s: string, i: number, arr: string[]) => arr.indexOf(s) === i), added: [...new Set(opsAdd.map((x) => x.size))] })
    }
    return { out, next: res.products.pageInfo.hasNextPage ? res.products.pageInfo.endCursor : null }
  },
})

// ---------- hard check before going live ----------

export const opsBySkus = internalQuery({
  args: { skus: v.array(v.string()) },
  handler: async (ctx, { skus }) => {
    const out: Record<string, any> = {}
    for (const sku of skus) {
      const x = await ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", sku)).first()
      if (!x) continue
      const st = await ctx.db.query("stock").withIndex("by_variant", (q) => q.eq("variantId", x._id)).collect()
      const prod = await ctx.db.get(x.productId)
      out[sku] = { price: x.price, cost: x.purchasePrice, active: x.active, available: st.reduce((t, r) => t + r.available, 0), virtual: st.reduce((t, r) => t + (r.virtual ?? 0), 0), preOrder: !!prod?.preOrder, productActive: !!prod?.active && !prod?.deletedAt }
    }
    return out
  },
})

export const audit = action({
  args: { query: v.string(), after: v.optional(v.string()), count: v.optional(v.number()), batches: v.optional(v.array(v.object({ batch: v.string(), parts: v.number(), markup: v.number() }))) },
  handler: async (ctx, a) => {
    await ctx.runQuery(internal.chinaImport.allowed, {})
    const want: Record<string, number> = {}
    for (const b of a.batches ?? []) for (const r of await loadRaw(ctx, b.batch, b.parts)) {
      const usd = r.ladder.length ? Math.max(...r.ladder.map((l) => l[2])) : r.skuPrice ?? 0
      if (usd > 0) want[String(r.id)] = priceOf(usd, b.markup)
    }
    const res = await shopifyGql(ctx, `query($q: String!, $n: Int!, $after: String, $pub: ID!) { products(first: $n, after: $after, query: $q) { pageInfo { hasNextPage endCursor } nodes {
      id handle title status tags onlineStoreUrl publishedOnPublication(publicationId: $pub) metafield(namespace: "custom", key: "supplier") { value } seo { title description } descriptionHtml
      media(first: 30) { nodes { status mediaContentType } }
      variants(first: 100) { nodes { sku price compareAtPrice inventoryPolicy inventoryItem { tracked } selectedOptions { name value } media(first: 1) { nodes { id } } } } } } }`,
      { q: a.query, n: a.count ?? 25, after: a.after ?? null, pub: ONLINE_STORE })
    const issues: any[] = []
    let checked = 0
    for (const p of res.products.nodes) {
      checked++
      const bad: string[] = []
      const tags: string[] = p.tags
      const china = tags.some((t) => t.startsWith("supplier-")) && !tags.includes("made-in-bangladesh")
      if (p.status !== "ACTIVE") bad.push(`status ${p.status}`)
      if (!p.publishedOnPublication) bad.push("not on the website")
      if (!p.media.nodes.length) bad.push("no pictures")
      if (p.media.nodes.some((m: any) => m.status !== "READY")) bad.push(`${p.media.nodes.filter((m: any) => m.status !== "READY").length} picture(s) not ready/broken`)
      if (!p.descriptionHtml || p.descriptionHtml.length < 40) bad.push("no description")
      const vs = p.variants.nodes
      const sizes = [...new Set(vs.map((x: any) => x.selectedOptions.find((o: any) => /size/i.test(o.name))?.value))]
      if (sizes.join(",") !== STANDARD_SIZES.join(",") && sizes.sort().join(",") !== STANDARD_SIZES.join(",")) bad.push(`sizes ${sizes.join(",")}`)
      const full = [...new Set(vs.map((x: any) => x.compareAtPrice))]
      if (china) {
        if (vs.some((x: any) => Number(x.price) !== BOOKING)) bad.push(`booking price not Tk ${BOOKING}: ${[...new Set(vs.map((x: any) => x.price))].join(",")}`)
        if (full.length !== 1 || !(Number(full[0]) > BOOKING)) bad.push(`full price missing/mixed: ${full.join(",")}`)
        if (!p.metafield?.value) bad.push("no supplier name")
        if (vs.some((x: any) => x.inventoryPolicy !== "CONTINUE" || x.inventoryItem?.tracked)) bad.push("stock tracking on (could show sold out)")
        const ali = tags.find((t) => t.startsWith("alibaba-"))?.slice(8)
        if (ali && want[ali] && Number(full[0]) !== want[ali]) bad.push(`price ${full[0]} but formula says ${want[ali]}`)
      }
      if (vs.some((x: any) => !x.media.nodes.length) && p.media.nodes.length > 1) bad.push(`${vs.filter((x: any) => !x.media.nodes.length).length} size(s) without a colour picture`)
      if (vs.some((x: any) => !x.sku)) bad.push("size(s) without SKU")
      const ops = await ctx.runQuery(internal.chinaImport.opsBySkus, { skus: vs.map((x: any) => x.sku).filter(Boolean) })
      const missing = vs.filter((x: any) => x.sku && !ops[x.sku])
      if (missing.length) bad.push(`${missing.length} size(s) not in Ops`)
      const shown = china ? Number(full[0]) : Number(vs[0]?.price)
      const wrongOps = vs.filter((x: any) => ops[x.sku] && ops[x.sku].price !== shown)
      if (wrongOps.length) bad.push(`Ops price differs (${ops[wrongOps[0].sku].price} vs ${shown})`)
      if (vs.some((x: any) => ops[x.sku] && !ops[x.sku].active)) bad.push("size switched off in Ops")
      if (vs.some((x: any) => ops[x.sku] && ops[x.sku].available <= 0)) bad.push(`${vs.filter((x: any) => ops[x.sku] && ops[x.sku].available <= 0).length} size(s) with 0 stock in Ops`)
      if (vs.some((x: any) => ops[x.sku] && !ops[x.sku].cost)) bad.push("purchase cost missing in Ops")
      if (bad.length) issues.push({ title: p.title, handle: p.handle, bad })
    }
    return { checked, issues, next: res.products.pageInfo.hasNextPage ? res.products.pageInfo.endCursor : null }
  },
})
