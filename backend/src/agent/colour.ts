// "Colour" (Stage 8 chunk H): words that claim an outcome or an intensity no tool result backs.
//
// The verifier already checks every number and every move. What was left is prose like "Ke3 cost
// you the game" or "cost you dearly" (both in a live answer, 12 Nov 2026): the tools say how many
// win-chance points a move lost, never that the game was lost BECAUSE of it. So a sentence may
// state a move's cost only as that figure.
//
// The list is deliberately TIGHT: a false hit costs a repair round and then a sentence. Left out
// on purpose, because they are ordinary chess prose: "badly" (a badly placed knight), "heavily"
// (heavily defended), "severely" (severely weakened), "decisive" (a decisive advantage),
// "crushing" (a crushing attack), "massive" on its own (a massive pawn centre), "always"/"never",
// and the size words "much"/"far" ("a much better move"; the ask prompt forbids them for comparing
// two groups, but code doesn't check).
// Checked against every stored real report and answer on 20 Nov 2026 (CLAUDE.md §10).

const PATTERNS: RegExp[] = [
  // Outcomes: "cost you the game", "costing you a point", "costs you the win".
  /\bcost(?:s|ing)?\s+you\s+(?:the|a|this|that|your|half\s+a|the\s+full|the\s+whole)\s+(?:game|point|win|draw|match|result)\b/gi,
  // "cost you games", "costing you valuable pieces and games".
  /\bcost(?:s|ing)?\s+you\s+(?:[\w'-]+\s+){0,3}games\b/gi,
  // "lost you the game", "loses you a point".
  /\b(?:lost|loses?|losing)\s+you\s+(?:the|a|this|that|your)\s+(?:game|point|win|draw|match)\b/gi,
  // "throws away the win", "threw the game away", "throwing it away".
  /\bthr(?:ows?|ew|own|owing)\s+(?:(?:it|them|this|that|everything)\s+|(?:the|a|your)\s+[\w'-]+\s+)?away\b/gi,
  /\bgame[\s-]+losing\b/gi,
  // Intensity nothing measured.
  // "massive" only as "massive swing(s)" (a live report, Nov 2026): a massive pawn centre is
  // ordinary chess prose.
  /\bmassive\s+swings?\b/gi,
  // An intensity adjective right before an error kind: "severe blunders", "a critical mistake"
  // (the v7 report, 20 Nov 2026). The kind (inaccuracy / mistake / blunder) already says how bad
  // a move was. Only in that position: "a critical position" is ordinary chess prose.
  /\b(?:severe|critical|serious|costly|terrible|huge|big|major)\s+(?:blunders?|mistakes?|inaccurac(?:y|ies))\b/gi,
  /\b(?:dearly|catastroph(?:e|ic|ically)|disast(?:er|rous|rously)|devastat(?:ing|ingly|ed)|fatal(?:ly)?)\b/gi,
];

// The colour phrases in a piece of prose, as written (lowercased), in order of the list above.
export function colourIn(text: string): string[] {
  return PATTERNS.flatMap((p) => [...text.matchAll(p)].map((m) => m[0].toLowerCase().replace(/\s+/g, " ")));
}

// What the repair round is told (the report's and the answer's issue lines end with this).
export const COLOUR_RULE = "an outcome or intensity no tool result backs: state what a move cost only as its win-chance figure, or leave it out";
