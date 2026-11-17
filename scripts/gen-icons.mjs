// Generates src/lib/board/icons.generated.ts: a curated, tree-shakeable subset
// of Lucide icons the lesson model may draw. Run: node scripts/gen-icons.mjs
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const lucide = require("lucide");

const CURATED = `
atom flask-conical microscope dna leaf sprout tree-deciduous tree-pine flower sun moon star cloud cloud-rain cloud-lightning
droplet droplets flame snowflake wind zap magnet battery lightbulb thermometer earth globe mountain waves fish bug bird cat dog
rabbit heart heart-pulse brain bone eye ear hand footprints pill syringe stethoscope activity apple carrot wheat egg
cpu server database hard-drive laptop monitor smartphone wifi router code terminal binary key lock lock-open shield
shield-check network mail message-circle link file file-text folder search settings cog wrench hammer plug cable radio
satellite rocket plane car bike train-front ship truck fuel coins banknote wallet piggy-bank credit-card chart-line
chart-column chart-pie trending-up trending-down building building-2 factory store shopping-cart scale landmark briefcase
handshake user users baby person-standing graduation-cap school book book-open notebook-pen pencil ruler calculator clock
hourglass calendar timer sigma pi infinity percent divide plus minus x equal triangle square circle hexagon pentagon cone
cylinder box music palette camera image film gamepad-2 puzzle target flag map map-pin compass house castle crown sword
scroll gavel vote trophy medal gift bell megaphone mic recycle trash-2 package layers shapes sparkles circle-help
triangle-alert circle-check circle-x arrow-right arrow-up arrow-down arrow-left refresh-cw repeat shuffle split merge
git-branch workflow orbit telescope gauge weight ship-wheel anchor tent sailboat bus tractor dumbbell utensils
cookie pizza coffee glass-water milk candy salad soup beef drumstick
`.split(/\s+/).filter(Boolean);

const ALIASES = {
  water: "droplet", rain: "cloud-rain", storm: "cloud-lightning", lightning: "zap", energy: "zap", electricity: "zap",
  power: "zap", fire: "flame", heat: "flame", hot: "flame", cold: "snowflake", ice: "snowflake", planet: "earth",
  world: "globe", plant: "sprout", seed: "sprout", tree: "tree-deciduous", forest: "tree-pine", money: "banknote",
  cash: "banknote", dollar: "banknote", coin: "coins", bank: "landmark", government: "landmark", computer: "monitor",
  pc: "monitor", phone: "smartphone", mobile: "smartphone", person: "user", human: "user", people: "users",
  population: "users", idea: "lightbulb", light: "lightbulb", bulb: "lightbulb", chart: "chart-line", graph: "chart-line",
  "bar-chart": "chart-column", "line-chart": "chart-line", "pie-chart": "chart-pie", growth: "trending-up",
  decline: "trending-down", time: "clock", warning: "triangle-alert", danger: "triangle-alert", question: "circle-help",
  correct: "circle-check", wrong: "circle-x", home: "house", city: "building-2", company: "building", shop: "store",
  cart: "shopping-cart", law: "gavel", justice: "scale", balance: "scale", election: "vote", gene: "dna",
  cell: "circle", virus: "bug", bacteria: "bug", germ: "bug", medicine: "pill", vaccine: "syringe", doctor: "stethoscope",
  health: "heart-pulse", pulse: "heart-pulse", food: "utensils", meal: "utensils", sugar: "candy", glucose: "candy",
  oxygen: "wind", air: "wind", gas: "wind", sound: "megaphone", music: "music", data: "database", storage: "database",
  internet: "globe", web: "globe", network: "network", security: "shield", password: "key", email: "mail",
  message: "message-circle", chat: "message-circle", document: "file-text", book: "book-open", study: "graduation-cap",
  student: "graduation-cap", teacher: "school", calendar: "calendar", space: "rocket", star: "star", sky: "cloud",
  ocean: "waves", sea: "waves", wave: "waves", river: "waves", mountain: "mountain", rock: "mountain",
  factory: "factory", industry: "factory", car: "car", vehicle: "car", train: "train-front", boat: "sailboat",
  temperature: "thermometer", speed: "gauge", pressure: "gauge", mass: "weight", gravity: "orbit", orbit: "orbit",
  magnet: "magnet", battery: "battery", recycle: "recycle", waste: "trash-2", goal: "target", aim: "target",
  winner: "trophy", map: "map", location: "map-pin", direction: "compass", history: "scroll", king: "crown",
  war: "sword", castle: "castle", art: "palette", photo: "camera", picture: "image", movie: "film", game: "gamepad-2",
  code: "code", program: "code", software: "code", cpu: "cpu", processor: "cpu", chip: "cpu", server: "server",
  cloud: "cloud", wifi: "wifi", signal: "radio", satellite: "satellite", search: "search", settings: "settings",
  gear: "cog", tool: "wrench", tools: "wrench", build: "hammer", loop: "repeat", cycle: "refresh-cw",
  split: "split", merge: "merge", branch: "git-branch", process: "workflow", math: "sigma", sum: "sigma",
  eye: "eye", vision: "eye", hear: "ear", brain: "brain", mind: "brain", think: "brain", bone: "bone",
  muscle: "dumbbell", exercise: "dumbbell", baby: "baby", child: "baby",
};

const pascal = (k) => k.split("-").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");

const found = [];
const missing = [];
for (const name of [...new Set(CURATED)]) {
  const exp = pascal(name);
  if (Array.isArray(lucide[exp])) found.push([name, exp]);
  else missing.push(name);
}
const aliasOut = Object.entries(ALIASES).filter(([, target]) => found.some(([n]) => n === target));

const lines = [
  "// Generated by scripts/gen-icons.mjs — do not edit by hand.",
  `import { ${found.map(([, e]) => e).join(", ")} } from "lucide";`,
  "",
  "export type IconNode = [tag: string, attrs: Record<string, string | number>][];",
  "",
  "export const ICONS: Record<string, IconNode> = {",
  ...found.map(([n, e]) => `  ${JSON.stringify(n)}: ${e} as IconNode,`),
  "};",
  "",
  "export const ICON_ALIASES: Record<string, string> = {",
  ...aliasOut.map(([a, t]) => `  ${JSON.stringify(a)}: ${JSON.stringify(t)},`),
  "};",
  "",
];
writeFileSync(new URL("../src/lib/board/icons.generated.ts", import.meta.url), lines.join("\n"));
console.log(`icons: ${found.length} found, aliases: ${aliasOut.length}`);
if (missing.length) console.log("missing:", missing.join(", "));
