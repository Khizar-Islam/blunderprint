// A bar (or an openings row) built on fewer than MIN_GAMES games is shown greyed out with a
// "few games" note: one daily game with two blunders is a 100% blunder rate, not a finding.
export const MIN_GAMES = 5;

export const fewGames = (games: number) => games < MIN_GAMES;
