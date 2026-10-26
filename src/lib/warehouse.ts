/** One fixed colour per warehouse, so the team recognises it at a glance:
 *  CTG = blue, Dhaka = green, CTG Exchange = orange, Dhaka Exchange = pink, anything else = violet. */
export function whTone(name?: string) {
  const n = (name ?? "").toLowerCase()
  const dhaka = /dhaka|dhk/.test(n)
  if (n.includes("exchange")) return dhaka ? "bg-tone-pink-bg text-tone-pink" : "bg-tone-orange-bg text-tone-orange"
  if (dhaka) return "bg-tone-green-bg text-tone-green"
  if (/ctg|chatto|chitt|blackbole$/.test(n.trim())) return "bg-tone-blue-bg text-tone-blue"
  return "bg-tone-violet-bg text-tone-violet"
}
