const DATA_PATH = "./data/";

const TABS = [
  ["predict", "Predict"],
  ["schedule", "Schedule"],
  ["props", "Pre-Tournament"],
  ["groups", "Groups"],
  ["bracket", "Bracket"],
  ["ratings", "Ratings"],
  ["results", "Results"],
  ["accuracy", "Accuracy"],
  ["sgpools", "SG Pools"],
  ["method", "Method"],
];

const STAGE_LABELS = {
  group: "Group stage",
  round32: "Round of 32",
  round16: "Round of 16",
  quarter: "Quarter-finals",
  semi: "Semi-finals",
  third: "Third-place play-off",
  final: "Final",
};

const GROUPS = "ABCDEFGHIJKL".split("");
const MAX_GOALS = 8;
const SG_POOLS_BET_TYPES = [
  ["MR", "1X2"],
  ["CS", "Pick the Score"],
  ["HL", "Total Goals Over/Under"],
  ["BG", "Will Both Teams Score"],
  ["EG", "Total Goals"],
  ["OE", "Total Goals Odd/Even"],
  ["AH", "Asian Handicap / HT Asian Handicap"],
  ["MH", "Handicap 1X2"],
  ["H1", "Halftime 1X2"],
  ["HF", "Halftime-Fulltime"],
  ["WH", "1/2 Goal"],
  ["NGN", "Team to Score 1st Goal"],
  ["FS", "1st Goal Scorer"],
  ["LS", "Last Goal Scorer"],
];

const DEFAULT_CONFIG = {
  runs: 12000,
  seed: 20260613,
  kFactor: 40,
  homeAdvantage: 35,
  hostBoost: 70,
  baseXg: 1.4,
  xgScale: 560,
  xgMin: 0.25,
  xgMax: 4.5,
  rho: -0.08,
  zeroInflation: 0.35,
  drawGuard: 12,
  styleWeight: 70,
  marketBlend: 50,
  upsetNoise: 22,
};

const state = {
  tab: validTab(location.hash.replace("#", "")),
  data: null,
  home: "",
  away: "",
  copied: false,
  copyFallback: false,
  bracketText: "",
  config: readConfig(),
  cache: new Map(),
};

const app = document.querySelector("#app");

init();

async function init() {
  const [schedule, results, scorers, history, odds, pretournament, model, singaporePools] = await Promise.all([
    loadJSON("schedule.json"),
    loadJSON("results.json"),
    loadJSON("scorers.json"),
    loadJSON("history.json"),
    loadJSON("odds.json"),
    loadJSON("pretournament.json"),
    loadJSON("team-model.json"),
    safeLoadJSON("sgpools-markets.json", defaultSingaporePoolsFeed()),
  ]);

  const teams = model.Hp.map((team) => ({
    ...team,
    host: Boolean(team.host),
    flag: model.Ip[team.name] || "",
    prior: model.Fp[team.name] || 1500,
  }));

  state.data = {
    schedule,
    results,
    scorers,
    history,
    odds,
    pretournament,
    singaporePools,
    teams,
    teamByName: Object.fromEntries(teams.map((team) => [team.name, team])),
    groups: groupTeams(teams),
    styles: buildStyleProfiles(teams, history),
  };

  const next = nextFixture(schedule, results);
  state.home = next?.homeTbd ? teams[0].name : next?.home || "Spain";
  state.away = next?.awayTbd ? teams[1].name : next?.away || "Argentina";

  window.addEventListener("hashchange", () => {
    state.tab = validTab(location.hash.replace("#", ""));
    render();
  });

  render();
}

async function loadJSON(file) {
  const response = await fetch(`${DATA_PATH}${file}`, { cache: "no-cache" });
  if (!response.ok) throw new Error(`Could not load ${file}`);
  return response.json();
}

async function safeLoadJSON(file, fallback) {
  try {
    return await loadJSON(file);
  } catch (error) {
    return fallback;
  }
}

function defaultSingaporePoolsFeed() {
  return {
    generatedAt: null,
    sourceUrl: "https://online.singaporepools.com/en/sports",
    status: "not_connected",
    note: "No live Singapore Pools market snapshot has been generated yet. The public sports page exposes football bet-type labels, while live event prices are loaded by Singapore Pools' app runtime.",
    betTypes: SG_POOLS_BET_TYPES.map(([code, name]) => ({ code, name })),
    events: [],
  };
}

function validTab(tab) {
  return TABS.some(([id]) => id === tab) ? tab : "predict";
}

function readConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(localStorage.getItem("wc26-config") || "{}") };
  } catch (error) {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig() {
  localStorage.setItem("wc26-config", JSON.stringify(state.config));
  state.cache.clear();
}

function groupTeams(teams) {
  return GROUPS.reduce((acc, group) => {
    acc[group] = teams.filter((team) => team.group === group);
    return acc;
  }, {});
}

function buildStyleProfiles(teams, history) {
  const profiles = {};
  for (const team of teams) {
    const matches = history
      .filter((match) => match.home === team.name || match.away === team.name)
      .slice(0, 14);
    if (!matches.length) {
      profiles[team.name] = { attack: 0, defense: 0, formPower: 0 };
      continue;
    }
    let weight = 0;
    let gf = 0;
    let ga = 0;
    let pts = 0;
    matches.forEach((match, index) => {
      const w = Math.exp(-index / 7);
      const isHome = match.home === team.name;
      const forGoals = isHome ? match.hg : match.ag;
      const againstGoals = isHome ? match.ag : match.hg;
      weight += w;
      gf += forGoals * w;
      ga += againstGoals * w;
      pts += (forGoals > againstGoals ? 3 : forGoals === againstGoals ? 1 : 0) * w;
    });
    const gfPer = gf / weight;
    const gaPer = ga / weight;
    const ppg = pts / weight;
    const attack = clamp((gfPer - 1.35) * 0.18 + (ppg - 1.4) * 0.035, -0.16, 0.16);
    const defense = clamp((1.35 - gaPer) * 0.18 + (ppg - 1.4) * 0.025, -0.16, 0.16);
    profiles[team.name] = { attack, defense, formPower: ppg };
  }
  return profiles;
}

function ratingsAfterResults(results, config = state.config) {
  const ratings = new Map(state.data.teams.map((team) => [team.name, team.prior]));
  const sorted = [...results].sort((a, b) => `${a.date}-${a.id}`.localeCompare(`${b.date}-${b.id}`));
  for (const match of sorted) updateElo(ratings, match, config);
  return ratings;
}

function updateElo(ratings, match, config) {
  const home = state.data.teamByName[match.home];
  const away = state.data.teamByName[match.away];
  if (!home || !away) return;
  const h = ratings.get(home.name) || home.prior;
  const a = ratings.get(away.name) || away.prior;
  const hEff = h + (home.host ? config.hostBoost : 0);
  const aEff = a + (away.host ? config.hostBoost : 0);
  const expected = logisticExpected(hEff, aEff);
  const actual = match.homeGoals > match.awayGoals ? 1 : match.homeGoals === match.awayGoals ? 0.5 : 0;
  const margin = Math.abs(match.homeGoals - match.awayGoals);
  const mov = margin <= 1 ? 1 : margin === 2 ? 1.5 : (11 + margin) / 8;
  const delta = config.kFactor * mov * (actual - expected);
  ratings.set(home.name, h + delta);
  ratings.set(away.name, a - delta);
}

function effectiveRating(teamName, ratings, options = {}) {
  const team = state.data.teamByName[teamName];
  let rating = ratings.get(teamName) || team?.prior || 1500;
  if (options.isHome) rating += state.config.homeAdvantage;
  if (team?.host && options.applyHostBoost !== false) rating += state.config.hostBoost;
  if (options.marketLift) rating += options.marketLift.get(teamName) || 0;
  if (options.rng && state.config.upsetNoise > 0) {
    rating += normal(options.rng) * state.config.upsetNoise;
  }
  return rating;
}

function logisticExpected(homeRating, awayRating) {
  return 1 / (1 + Math.pow(10, (awayRating - homeRating) / 400));
}

function matchPrediction(homeName, awayName, ratings, options = {}) {
  const config = options.config || state.config;
  const homeRating = effectiveRating(homeName, ratings, {
    isHome: options.homeAdvantage,
    applyHostBoost: true,
    rng: options.rng,
    marketLift: options.marketLift,
  });
  const awayRating = effectiveRating(awayName, ratings, {
    applyHostBoost: true,
    rng: options.rng,
    marketLift: options.marketLift,
  });
  const style = state.data.styles;
  const homeStyle = style[homeName] || { attack: 0, defense: 0 };
  const awayStyle = style[awayName] || { attack: 0, defense: 0 };
  const styleWeight = config.styleWeight / 100;
  const homeStyleMultiplier = Math.exp((homeStyle.attack - awayStyle.defense) * styleWeight);
  const awayStyleMultiplier = Math.exp((awayStyle.attack - homeStyle.defense) * styleWeight);
  const lambdaHome = clamp(
    config.baseXg * Math.exp((homeRating - awayRating) / config.xgScale) * homeStyleMultiplier,
    config.xgMin,
    config.xgMax,
  );
  const lambdaAway = clamp(
    config.baseXg * Math.exp((awayRating - homeRating) / config.xgScale) * awayStyleMultiplier,
    config.xgMin,
    config.xgMax,
  );
  const matrix = scoreMatrix(lambdaHome, lambdaAway, config);
  const raw = summarizeMatrix(matrix);
  const closeness = Math.exp(-Math.abs(homeRating - awayRating) / 185);
  const drawExtra = (config.drawGuard / 100) * closeness * (1 - raw.pDraw) * 0.28;
  const nonDraw = raw.pHome + raw.pAway || 1;
  const pDraw = clamp(raw.pDraw + drawExtra, 0.02, 0.62);
  const pHome = raw.pHome - drawExtra * (raw.pHome / nonDraw);
  const pAway = raw.pAway - drawExtra * (raw.pAway / nonDraw);
  const total = pHome + pDraw + pAway;
  return {
    homeName,
    awayName,
    lambdaHome,
    lambdaAway,
    matrix,
    pHome: pHome / total,
    pDraw: pDraw / total,
    pAway: pAway / total,
    over25: raw.over25,
    btts: raw.btts,
    topScorelines: raw.topScorelines,
    ratingDiff: homeRating - awayRating,
  };
}

function scoreMatrix(lambdaHome, lambdaAway, config) {
  const homeDist = Array.from({ length: MAX_GOALS + 1 }, (_, goals) => poissonProbability(lambdaHome, goals));
  const awayDist = Array.from({ length: MAX_GOALS + 1 }, (_, goals) => poissonProbability(lambdaAway, goals));
  const matrix = [];
  let total = 0;
  for (let h = 0; h <= MAX_GOALS; h += 1) {
    matrix[h] = [];
    for (let a = 0; a <= MAX_GOALS; a += 1) {
      const dc = dixonColes(h, a, lambdaHome, lambdaAway, config.rho);
      const zero = h === 0 && a === 0 ? 1 + config.zeroInflation : 1;
      const value = Math.max(0, homeDist[h] * awayDist[a] * dc * zero);
      matrix[h][a] = value;
      total += value;
    }
  }
  for (let h = 0; h <= MAX_GOALS; h += 1) {
    for (let a = 0; a <= MAX_GOALS; a += 1) matrix[h][a] /= total;
  }
  return matrix;
}

function poissonProbability(lambda, goals) {
  let factorial = 1;
  for (let i = 2; i <= goals; i += 1) factorial *= i;
  return (Math.pow(lambda, goals) * Math.exp(-lambda)) / factorial;
}

function dixonColes(h, a, lh, la, rho) {
  if (h === 0 && a === 0) return 1 - lh * la * rho;
  if (h === 0 && a === 1) return 1 + lh * rho;
  if (h === 1 && a === 0) return 1 + la * rho;
  if (h === 1 && a === 1) return 1 - rho;
  return 1;
}

function summarizeMatrix(matrix) {
  let pHome = 0;
  let pDraw = 0;
  let pAway = 0;
  let over25 = 0;
  let btts = 0;
  const scores = [];
  for (let h = 0; h < matrix.length; h += 1) {
    for (let a = 0; a < matrix[h].length; a += 1) {
      const p = matrix[h][a];
      if (h > a) pHome += p;
      else if (h === a) pDraw += p;
      else pAway += p;
      if (h + a >= 3) over25 += p;
      if (h > 0 && a > 0) btts += p;
      scores.push({ h, a, p });
    }
  }
  scores.sort((x, y) => y.p - x.p);
  return { pHome, pDraw, pAway, over25, btts, topScorelines: scores.slice(0, 8) };
}

function currentStandings(results = state.data.results) {
  const standings = new Map();
  for (const team of state.data.teams) standings.set(team.name, emptyStanding(team));
  for (const result of results.filter((match) => match.stage === "group")) {
    applyResultToStandings(standings, result.home, result.away, result.homeGoals, result.awayGoals);
  }
  return standings;
}

function emptyStanding(team) {
  return { team, played: 0, won: 0, drawn: 0, lost: 0, pts: 0, gf: 0, ga: 0, gd: 0 };
}

function applyResultToStandings(standings, homeName, awayName, hg, ag) {
  const home = standings.get(homeName);
  const away = standings.get(awayName);
  if (!home || !away) return;
  home.played += 1;
  away.played += 1;
  home.gf += hg;
  home.ga += ag;
  away.gf += ag;
  away.ga += hg;
  home.gd = home.gf - home.ga;
  away.gd = away.gf - away.ga;
  if (hg > ag) {
    home.won += 1;
    away.lost += 1;
    home.pts += 3;
  } else if (ag > hg) {
    away.won += 1;
    home.lost += 1;
    away.pts += 3;
  } else {
    home.drawn += 1;
    away.drawn += 1;
    home.pts += 1;
    away.pts += 1;
  }
}

function sortStandings(rows, ratings, random = null) {
  return [...rows].sort((a, b) => (
    b.pts - a.pts ||
    b.gd - a.gd ||
    b.gf - a.gf ||
    (ratings.get(b.team.name) || b.team.prior) - (ratings.get(a.team.name) || a.team.prior) ||
    (random ? random() - 0.5 : a.team.name.localeCompare(b.team.name))
  ));
}

function groupRows(group, standings, ratings) {
  const rows = state.data.groups[group].map((team) => standings.get(team.name));
  return sortStandings(rows, ratings);
}

function getSimulation() {
  const key = JSON.stringify({
    results: state.data.results.map((r) => `${r.id}:${r.homeGoals}-${r.awayGoals}`).join("|"),
    config: state.config,
  });
  if (!state.cache.has(key)) {
    const ratings = ratingsAfterResults(state.data.results);
    state.cache.set(key, simulateMany(ratings, state.config.runs, state.config.seed, state.config));
  }
  return state.cache.get(key);
}

function simulateMany(ratings, runs, seed, config) {
  const random = mulberry32(seed);
  const stats = new Map();
  for (const team of state.data.teams) {
    stats.set(team.name, {
      team,
      groupWin: 0,
      top2: 0,
      advance: 0,
      round16: 0,
      quarter: 0,
      semi: 0,
      final: 0,
      winner: 0,
      goals: 0,
      goalDist: new Map(),
    });
  }
  const champions = new Map();
  const topScorerDist = new Map();
  const zeroZeroDist = new Map();
  let avgTopScorer = 0;
  let avgZeroZero = 0;

  for (let run = 0; run < runs; run += 1) {
    const sim = simulateOne(ratings, random, config);
    champions.set(sim.champion.name, (champions.get(sim.champion.name) || 0) + 1);
    topScorerDist.set(sim.topScorerGoals, (topScorerDist.get(sim.topScorerGoals) || 0) + 1);
    zeroZeroDist.set(sim.zeroZero, (zeroZeroDist.get(sim.zeroZero) || 0) + 1);
    avgTopScorer += sim.topScorerGoals;
    avgZeroZero += sim.zeroZero;
    for (const team of state.data.teams) {
      const row = stats.get(team.name);
      const reach = sim.reach.get(team.name);
      if (sim.groupWinners.has(team.name)) row.groupWin += 1;
      if (sim.topTwo.has(team.name)) row.top2 += 1;
      if (reach.round32) row.advance += 1;
      if (reach.round16) row.round16 += 1;
      if (reach.quarter) row.quarter += 1;
      if (reach.semi) row.semi += 1;
      if (reach.final) row.final += 1;
      if (reach.winner) row.winner += 1;
      const goals = sim.goals.get(team.name) || 0;
      row.goals += goals;
      row.goalDist.set(goals, (row.goalDist.get(goals) || 0) + 1);
    }
  }

  const championProb = [...champions.entries()]
    .map(([name, count]) => ({ team: state.data.teamByName[name], p: count / runs }))
    .sort((a, b) => b.p - a.p);

  const teamStats = [...stats.values()].map((row) => ({
    ...row,
    groupWin: row.groupWin / runs,
    top2: row.top2 / runs,
    advance: row.advance / runs,
    round16: row.round16 / runs,
    quarter: row.quarter / runs,
    semi: row.semi / runs,
    final: row.final / runs,
    winner: row.winner / runs,
    meanGoals: row.goals / runs,
  }));

  return {
    runs,
    championProb,
    teamStats,
    teamStatsByName: new Map(teamStats.map((row) => [row.team.name, row])),
    topScorerDist: normalizeDist(topScorerDist, runs),
    zeroZeroDist: normalizeDist(zeroZeroDist, runs),
    avgTopScorer: avgTopScorer / runs,
    avgZeroZero: avgZeroZero / runs,
  };
}

function simulateOne(ratings, random, config) {
  const standings = new Map();
  const goals = new Map();
  const reach = new Map();
  for (const team of state.data.teams) {
    standings.set(team.name, emptyStanding(team));
    goals.set(team.name, 0);
    reach.set(team.name, {
      round32: false,
      round16: false,
      quarter: false,
      semi: false,
      final: false,
      winner: false,
    });
  }

  const actualIds = new Set(state.data.results.map((result) => result.id));
  let zeroZero = 0;
  for (const result of state.data.results.filter((match) => match.stage === "group")) {
    applyResultToStandings(standings, result.home, result.away, result.homeGoals, result.awayGoals);
    addGoals(goals, result.home, result.homeGoals);
    addGoals(goals, result.away, result.awayGoals);
    if (result.homeGoals === 0 && result.awayGoals === 0) zeroZero += 1;
  }

  for (const fixture of state.data.schedule.filter((match) => match.stage === "group" && !actualIds.has(match.id))) {
    const score = sampleScore(fixture.home, fixture.away, ratings, random, config);
    applyResultToStandings(standings, fixture.home, fixture.away, score.hg, score.ag);
    addGoals(goals, fixture.home, score.hg);
    addGoals(goals, fixture.away, score.ag);
    if (score.hg === 0 && score.ag === 0) zeroZero += 1;
  }

  const groupWinners = new Set();
  const topTwo = new Set();
  const groupWinner = new Map();
  const groupRunner = new Map();
  const thirds = [];
  for (const group of GROUPS) {
    const rows = groupRows(group, standings, ratings);
    groupWinner.set(group, rows[0].team);
    groupRunner.set(group, rows[1].team);
    groupWinners.add(rows[0].team.name);
    topTwo.add(rows[0].team.name);
    topTwo.add(rows[1].team.name);
    thirds.push({ team: rows[2].team, group, row: rows[2] });
  }

  const bestThirds = thirds
    .sort((a, b) => b.row.pts - a.row.pts || b.row.gd - a.row.gd || b.row.gf - a.row.gf || random() - 0.5)
    .slice(0, 8);
  const thirdSlots = assignThirds(bestThirds, thirdRequirements());

  const winners = new Map();
  const losers = new Map();
  let champion = null;
  const resolveSlot = (slot, matchNum) => {
    if (slot.startsWith("1")) return groupWinner.get(slot[1]);
    if (slot.startsWith("2")) return groupRunner.get(slot[1]);
    if (slot.startsWith("3")) return thirdSlots.get(matchNum);
    if (slot.startsWith("W")) return winners.get(Number(slot.slice(1)));
    if (slot.startsWith("L")) return losers.get(Number(slot.slice(1)));
    return state.data.teamByName[slot];
  };

  for (const team of [...groupWinner.values(), ...groupRunner.values(), ...thirdSlots.values()]) {
    if (team) reach.get(team.name).round32 = true;
  }

  for (const fixture of state.data.schedule.filter((match) => match.stage !== "group")) {
    const home = resolveSlot(fixture.home, fixture.num);
    const away = resolveSlot(fixture.away, fixture.num);
    const played = sampleKnockout(home.name, away.name, ratings, random, config);
    addGoals(goals, home.name, played.hg);
    addGoals(goals, away.name, played.ag);
    if (played.hg === 0 && played.ag === 0) zeroZero += 1;
    const winner = played.winner === home.name ? home : away;
    const loser = winner.name === home.name ? away : home;
    winners.set(fixture.num, winner);
    losers.set(fixture.num, loser);
    if (fixture.stage === "round32") reach.get(winner.name).round16 = true;
    if (fixture.stage === "round16") reach.get(winner.name).quarter = true;
    if (fixture.stage === "quarter") reach.get(winner.name).semi = true;
    if (fixture.stage === "semi") reach.get(winner.name).final = true;
    if (fixture.stage === "final") {
      reach.get(winner.name).winner = true;
      champion = winner;
    }
  }

  let topScorerGoals = 0;
  for (const team of state.data.teams) {
    const total = goals.get(team.name) || 0;
    const share = 0.2 + random() * 0.07;
    const scorerGoals = poissonSample(total * share, random);
    if (scorerGoals > topScorerGoals) topScorerGoals = scorerGoals;
  }

  return { champion, standings, groupWinners, topTwo, reach, goals, topScorerGoals, zeroZero };
}

function addGoals(map, team, goals) {
  map.set(team, (map.get(team) || 0) + goals);
}

function sampleScore(home, away, ratings, random, config) {
  const prediction = matchPrediction(home, away, ratings, { rng: random, config });
  const pick = random();
  let cumulative = 0;
  for (let h = 0; h < prediction.matrix.length; h += 1) {
    for (let a = 0; a < prediction.matrix[h].length; a += 1) {
      cumulative += prediction.matrix[h][a];
      if (pick <= cumulative) return { hg: h, ag: a };
    }
  }
  return { hg: 1, ag: 1 };
}

function sampleKnockout(home, away, ratings, random, config) {
  const score = sampleScore(home, away, ratings, random, config);
  let hg = score.hg;
  let ag = score.ag;
  if (hg === ag) {
    const prediction = matchPrediction(home, away, ratings, { rng: random, config });
    hg += poissonSample(prediction.lambdaHome / 3, random);
    ag += poissonSample(prediction.lambdaAway / 3, random);
  }
  let winner;
  if (hg > ag) winner = home;
  else if (ag > hg) winner = away;
  else {
    const prediction = matchPrediction(home, away, ratings, { config });
    winner = random() < prediction.pHome / (prediction.pHome + prediction.pAway) ? home : away;
  }
  return { hg, ag, winner };
}

function deterministicProjection(ratings) {
  const standings = currentStandings();
  const actualIds = new Set(state.data.results.map((result) => result.id));
  const projectedGroupScores = [];
  for (const fixture of state.data.schedule.filter((match) => match.stage === "group" && !actualIds.has(match.id))) {
    const prediction = matchPrediction(fixture.home, fixture.away, ratings);
    const score = bestScoreline(prediction, "any");
    applyResultToStandings(standings, fixture.home, fixture.away, score.hg, score.ag);
    projectedGroupScores.push({ ...fixture, homeGoals: score.hg, awayGoals: score.ag });
  }
  const groupWinner = new Map();
  const groupRunner = new Map();
  const thirds = [];
  for (const group of GROUPS) {
    const rows = groupRows(group, standings, ratings);
    groupWinner.set(group, rows[0].team);
    groupRunner.set(group, rows[1].team);
    thirds.push({ team: rows[2].team, group, row: rows[2] });
  }
  const bestThirds = thirds
    .sort((a, b) => b.row.pts - a.row.pts || b.row.gd - a.row.gd || b.row.gf - a.row.gf || ratingOf(b.team, ratings) - ratingOf(a.team, ratings))
    .slice(0, 8);
  const thirdSlots = assignThirds(bestThirds, thirdRequirements());
  const winners = new Map();
  const losers = new Map();
  const games = [];
  const resolveSlot = (slot, matchNum) => {
    if (slot.startsWith("1")) return groupWinner.get(slot[1]);
    if (slot.startsWith("2")) return groupRunner.get(slot[1]);
    if (slot.startsWith("3")) return thirdSlots.get(matchNum);
    if (slot.startsWith("W")) return winners.get(Number(slot.slice(1)));
    if (slot.startsWith("L")) return losers.get(Number(slot.slice(1)));
    return state.data.teamByName[slot];
  };
  for (const fixture of state.data.schedule.filter((match) => match.stage !== "group")) {
    const home = resolveSlot(fixture.home, fixture.num);
    const away = resolveSlot(fixture.away, fixture.num);
    const prediction = matchPrediction(home.name, away.name, ratings);
    const homeFav = prediction.pHome >= prediction.pAway;
    const close = Math.abs(prediction.pHome - prediction.pAway) < 0.045;
    const score = bestScoreline(prediction, homeFav ? "home" : "away", close);
    const winner = homeFav ? home : away;
    const loser = winner.name === home.name ? away : home;
    winners.set(fixture.num, winner);
    losers.set(fixture.num, loser);
    games.push({
      ...fixture,
      homeTeam: home,
      awayTeam: away,
      homeGoals: score.hg,
      awayGoals: score.ag,
      winner,
      pens: close,
      pHome: prediction.pHome,
      pAway: prediction.pAway,
    });
  }
  return { standings, projectedGroupScores, games };
}

function bestScoreline(prediction, side = "any", allowDraw = false) {
  const candidates = [];
  for (let h = 0; h < prediction.matrix.length; h += 1) {
    for (let a = 0; a < prediction.matrix[h].length; a += 1) {
      if (side === "home" && h <= a && !allowDraw) continue;
      if (side === "away" && a <= h && !allowDraw) continue;
      if (side === "home" && allowDraw && h < a) continue;
      if (side === "away" && allowDraw && a < h) continue;
      candidates.push({ hg: h, ag: a, p: prediction.matrix[h][a] });
    }
  }
  candidates.sort((a, b) => b.p - a.p);
  return candidates[0] || { hg: side === "away" ? 0 : 1, ag: side === "away" ? 1 : 0 };
}

function thirdRequirements() {
  return state.data.schedule
    .filter((match) => match.stage === "round32" && match.away.startsWith("3"))
    .map((match) => ({ num: match.num, groups: match.away.slice(1).split("/") }));
}

function assignThirds(bestThirds, slots) {
  const assigned = new Map();
  const used = new Array(bestThirds.length).fill(false);
  const ordered = [...slots].sort((a, b) => a.groups.length - b.groups.length);
  const search = (index) => {
    if (index === ordered.length) return true;
    const slot = ordered[index];
    for (let i = 0; i < bestThirds.length; i += 1) {
      if (!used[i] && slot.groups.includes(bestThirds[i].group)) {
        used[i] = true;
        assigned.set(slot.num, bestThirds[i].team);
        if (search(index + 1)) return true;
        used[i] = false;
        assigned.delete(slot.num);
      }
    }
    return false;
  };
  if (!search(0)) {
    let pointer = 0;
    for (const slot of ordered) {
      if (assigned.has(slot.num)) continue;
      while (used[pointer]) pointer += 1;
      assigned.set(slot.num, bestThirds[pointer]?.team);
      used[pointer] = true;
    }
  }
  return assigned;
}

function normalizeDist(dist, runs) {
  return [...dist.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([value, count]) => ({ value: Number(value), p: count / runs }));
}

function marketProbabilityMap(oddsData) {
  const entries = Object.entries(oddsData.odds || {}).map(([team, odds]) => [team, 1 / odds]);
  const total = entries.reduce((sum, [, p]) => sum + p, 0) || 1;
  return new Map(entries.map(([team, p]) => [team, p / total]));
}

function blendedChampionProb(sim, oddsData, blend) {
  const market = marketProbabilityMap(oddsData);
  const model = new Map(sim.championProb.map((row) => [row.team.name, row.p]));
  const weight = blend / 100;
  return state.data.teams
    .map((team) => ({
      team,
      model: model.get(team.name) || 0,
      market: market.get(team.name) || 0,
      blended: (1 - weight) * (model.get(team.name) || 0) + weight * (market.get(team.name) || 0),
    }))
    .sort((a, b) => b.blended - a.blended);
}

function nextFixture(schedule, results) {
  const played = new Set(results.map((result) => result.id));
  return schedule.find((match) => !played.has(match.id) && !match.homeTbd && !match.awayTbd) || null;
}

function resultMap() {
  return new Map(state.data.results.map((result) => [result.id, result]));
}

function gradePredictions(results) {
  const ratings = new Map(state.data.teams.map((team) => [team.name, team.prior]));
  const sorted = [...results].sort((a, b) => `${a.date}-${a.id}`.localeCompare(`${b.date}-${b.id}`));
  return sorted.map((match) => {
    const prediction = matchPrediction(match.home, match.away, ratings);
    const actual = match.homeGoals > match.awayGoals ? "home" : match.homeGoals < match.awayGoals ? "away" : "draw";
    const probs = { home: prediction.pHome, draw: prediction.pDraw, away: prediction.pAway };
    const picked = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0];
    const graded = {
      match,
      prediction,
      actual,
      picked,
      correct: actual === picked,
      pActual: probs[actual],
    };
    updateElo(ratings, match, state.config);
    return graded;
  });
}

function accuracyScores(graded) {
  if (!graded.length) return { n: 0, hitRate: 0, brier: 0, logLoss: 0, trend: [] };
  let hits = 0;
  let brier = 0;
  let logLoss = 0;
  const trend = [];
  for (const row of graded) {
    const actual = row.actual;
    const p = { home: row.prediction.pHome, draw: row.prediction.pDraw, away: row.prediction.pAway };
    brier += (p.home - (actual === "home" ? 1 : 0)) ** 2;
    brier += (p.draw - (actual === "draw" ? 1 : 0)) ** 2;
    brier += (p.away - (actual === "away" ? 1 : 0)) ** 2;
    logLoss += -Math.log(Math.max(1e-12, row.pActual));
    if (row.correct) hits += 1;
    trend.push(logLoss / trend.length + 0);
  }
  const cumulative = [];
  let running = 0;
  graded.forEach((row, index) => {
    running += -Math.log(Math.max(1e-12, row.pActual));
    cumulative.push(running / (index + 1));
  });
  return {
    n: graded.length,
    hitRate: hits / graded.length,
    brier: brier / graded.length,
    logLoss: logLoss / graded.length,
    trend: cumulative,
  };
}

function render() {
  if (!state.data) {
    app.innerHTML = `<div class="shell"><div class="empty">Loading predictor data...</div></div>`;
    return;
  }
  const ratings = ratingsAfterResults(state.data.results);
  const sim = getSimulation();
  const projection = deterministicProjection(ratings);
  const active = state.tab;
  app.innerHTML = `
    <div class="shell">
      ${renderHeader(sim)}
      ${renderNav(active)}
      <main>${renderTab(active, ratings, sim, projection)}</main>
      ${renderFooter()}
    </div>
  `;
  bindEvents();
}

function renderHeader(sim) {
  const leader = sim.championProb[0];
  return `
    <header class="topbar">
      <div>
        <div class="eyebrow">World Cup 2026</div>
        <h1><span class="accent-green">Predictor</span> Lab</h1>
        <p class="lede">
          Elo ratings become expected goals, expected goals become scorelines, and ${fmtInt(state.config.runs)}
          Monte Carlo tournament runs turn those match odds into group, bracket, and title probabilities.
        </p>
      </div>
      <div class="header-actions">
        <span class="pill"><span class="accent-green">${leader.team.flag}</span><strong>${leader.team.name}</strong> ${pct(leader.p, 1)} title</span>
        <span class="pill"><strong>${state.data.results.length}</strong> played</span>
        <button class="icon-button" data-action="theme" aria-label="Toggle theme" title="Toggle theme">${document.documentElement.classList.contains("light") ? "◐" : "☼"}</button>
      </div>
    </header>
  `;
}

function renderNav(active) {
  return `
    <nav class="nav" aria-label="Predictor sections">
      ${TABS.map(([id, label]) => `<button class="nav-button ${active === id ? "active" : ""}" data-tab="${id}">${label}</button>`).join("")}
    </nav>
  `;
}

function renderTab(tab, ratings, sim, projection) {
  if (tab === "predict") return renderPredict(ratings, sim);
  if (tab === "schedule") return renderSchedule(ratings);
  if (tab === "props") return renderProps(sim);
  if (tab === "groups") return renderGroups(ratings, sim);
  if (tab === "bracket") return renderBracket(projection);
  if (tab === "ratings") return renderRatings(ratings);
  if (tab === "results") return renderResults();
  if (tab === "accuracy") return renderAccuracy();
  if (tab === "sgpools") return renderSingaporePools(ratings);
  return renderMethod(ratings, sim);
}

function renderPredict(ratings, sim) {
  const home = state.data.teamByName[state.home] || state.data.teams[0];
  const away = state.data.teamByName[state.away] || state.data.teams[1];
  const prediction = matchPrediction(home.name, away.name, ratings);
  const next = nextFixture(state.data.schedule, state.data.results);
  return `
    <div class="grid two">
      <section class="panel pad">
        ${next ? renderNextMatch(next, ratings) : ""}
        <div class="section-head" style="margin-top:16px">
          <div>
            <div class="label">Matchup</div>
            <h2>${home.flag} ${home.name} vs ${away.flag} ${away.name}</h2>
          </div>
        </div>
        <div class="select-row">
          ${teamSelect("home", home.name)}
          <span class="versus">vs</span>
          ${teamSelect("away", away.name)}
        </div>
        <div class="grid two" style="margin-top:14px">
          ${renderTeamCard(home, ratings, sim)}
          ${renderTeamCard(away, ratings, sim)}
        </div>
      </section>
      <section class="panel pad">
        <div class="match-hero">
          <div class="team-side">
            <div class="team-name"><span class="flag">${home.flag}</span><span class="truncate">${home.name}</span></div>
            <span class="muted">xG ${prediction.lambdaHome.toFixed(2)}</span>
          </div>
          <span class="versus">${prediction.pDraw > prediction.pHome && prediction.pDraw > prediction.pAway ? "D" : prediction.pHome > prediction.pAway ? "1" : "2"}</span>
          <div class="team-side right">
            <div class="team-name"><span class="truncate">${away.name}</span><span class="flag">${away.flag}</span></div>
            <span class="muted">xG ${prediction.lambdaAway.toFixed(2)}</span>
          </div>
        </div>
        <div class="odds-row" style="margin-top:12px">
          <div class="prob-card"><span class="label">${home.code}</span><strong class="accent-green">${pct(prediction.pHome, 1)}</strong></div>
          <div class="prob-card"><span class="label">Draw</span><strong class="accent-amber">${pct(prediction.pDraw, 1)}</strong></div>
          <div class="prob-card"><span class="label">${away.code}</span><strong class="accent-cyan">${pct(prediction.pAway, 1)}</strong></div>
        </div>
        <div class="bar" style="margin-top:12px">
          <span class="bar-home" style="width:${prediction.pHome * 100}%"></span>
          <span class="bar-draw" style="width:${prediction.pDraw * 100}%"></span>
          <span class="bar-away" style="width:${prediction.pAway * 100}%"></span>
        </div>
        <div class="grid four" style="margin-top:12px">
          ${metric("Over 2.5", pct(prediction.over25, 0), "Poisson total goals", "accent-cyan")}
          ${metric("BTTS", pct(prediction.btts, 0), "both teams score", "accent-green")}
          ${metric("Elo gap", signed(Math.round(prediction.ratingDiff)), `${home.name} minus ${away.name}`, "accent-violet")}
          ${metric("Draw guard", `${state.config.drawGuard}%`, "close-team adjustment", "accent-amber")}
        </div>
        <p class="muted" style="margin-top:12px;line-height:1.5">${matchRead(home, away, prediction)}</p>
      </section>
    </div>
    <div class="grid two" style="margin-top:14px">
      <section class="panel pad">
        <div class="section-head">
          <div>
            <div class="label">Scoreline matrix</div>
            <h2>Exact-score probabilities</h2>
          </div>
        </div>
        ${renderScoreMatrix(prediction, home.code, away.code)}
      </section>
      <section class="panel pad">
        <div class="section-head">
          <div>
            <div class="label">Most likely scorelines</div>
            <h2>Modal paths</h2>
          </div>
        </div>
        ${renderTopScorelines(prediction, home, away)}
        ${renderHeadToHead(home.name, away.name)}
      </section>
    </div>
    ${renderControls()}
  `;
}

function renderNextMatch(match, ratings) {
  const prediction = matchPrediction(match.home, match.away, ratings);
  const fav = prediction.pHome > prediction.pAway ? state.data.teamByName[match.home] : state.data.teamByName[match.away];
  const favProb = Math.max(prediction.pHome, prediction.pAway);
  const home = state.data.teamByName[match.home];
  const away = state.data.teamByName[match.away];
  return `
    <div class="panel flat pad" style="background:var(--panel-2)">
      <div class="section-head">
        <div>
          <div class="label">Next match</div>
          <h2>${localFixtureTime(match)}</h2>
        </div>
        <span class="tag">${STAGE_LABELS[match.stage]}${match.group ? ` · Group ${match.group}` : ""}</span>
      </div>
      <div class="match-row">
        <span class="faint">${match.num}</span>
        <span class="team-inline">${home.flag}<span>${home.name}</span></span>
        <span class="center-score">v</span>
        <span class="team-inline">${away.flag}<span>${away.name}</span></span>
        <span class="tag">${fav.code} ${pct(favProb, 0)}</span>
      </div>
      <p class="muted" style="margin-top:8px">Venue: ${match.venue} · listed local kickoff ${match.time}</p>
    </div>
  `;
}

function teamSelect(kind, selected) {
  return `
    <select data-select="${kind}" aria-label="${kind === "home" ? "First team" : "Second team"}">
      ${state.data.teams.map((team) => `<option value="${escapeAttr(team.name)}" ${team.name === selected ? "selected" : ""}>${team.flag} ${team.name} (${team.code})</option>`).join("")}
    </select>
  `;
}

function renderTeamCard(team, ratings, sim) {
  const rank = [...state.data.teams]
    .sort((a, b) => ratingOf(b, ratings) - ratingOf(a, ratings))
    .findIndex((row) => row.name === team.name) + 1;
  const row = sim.teamStatsByName.get(team.name);
  const form = recentForm(team.name, 5);
  return `
    <div class="team-card panel flat pad">
      <div class="section-head" style="margin-bottom:0">
        <div>
          <h3>${team.flag} ${team.name}</h3>
          <span class="muted">${team.code} · Group ${team.group}</span>
        </div>
        <strong class="accent-green">${Math.round(ratingOf(team, ratings))}</strong>
      </div>
      <div class="team-meta">
        <span class="tag">#${rank}</span>
        ${team.host ? `<span class="tag accent-green">Host</span>` : ""}
        <span class="tag">Title ${pct(row?.winner || 0, 1)}</span>
        <span class="tag">Advance ${pct(row?.advance || 0, 0)}</span>
      </div>
      <div>
        <div class="mini-label">Recent form</div>
        <div class="form-dots" style="margin-top:6px">
          ${form.map((item) => `<span class="form-dot ${item.result}" title="${item.result} ${item.gf}-${item.ga} vs ${escapeAttr(item.opp)}">${item.result}</span>`).join("") || `<span class="muted">No recent data</span>`}
        </div>
      </div>
    </div>
  `;
}

function renderScoreMatrix(prediction, homeCode, awayCode) {
  const max = Math.max(...prediction.matrix.flat());
  const cols = Array.from({ length: 7 }, (_, i) => i);
  return `
    <div class="matrix-wrap">
      <table class="score-matrix">
        <thead>
          <tr><th>${homeCode}/${awayCode}</th>${cols.map((col) => `<th>${col}</th>`).join("")}</tr>
        </thead>
        <tbody>
          ${cols.map((h) => `
            <tr>
              <th>${h}</th>
              ${cols.map((a) => `<td class="heat" style="--heat:${Math.max(4, prediction.matrix[h][a] / max * 92)}">${pct(prediction.matrix[h][a], 0)}</td>`).join("")}
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    <p class="muted" style="margin-top:10px">Rows are ${homeCode}, columns are ${awayCode}. Probabilities beyond six goals are included in the model but hidden from this compact grid.</p>
  `;
}

function renderTopScorelines(prediction, home, away) {
  return `
    <div class="list">
      ${prediction.topScorelines.map((score, index) => `
        <div class="match-row">
          <span class="faint">#${index + 1}</span>
          <span class="team-inline">${home.flag}<span>${home.code}</span></span>
          <span class="center-score">${score.h}-${score.a}</span>
          <span class="team-inline">${away.flag}<span>${away.code}</span></span>
          <strong>${pct(score.p, 1)}</strong>
        </div>
      `).join("")}
    </div>
  `;
}

function renderHeadToHead(home, away) {
  const meetings = state.data.history
    .filter((match) => (match.home === home && match.away === away) || (match.home === away && match.away === home))
    .slice(0, 5);
  return `
    <div style="margin-top:16px">
      <div class="section-head">
        <div>
          <div class="label">Head-to-head</div>
          <h2>Recent meetings</h2>
        </div>
      </div>
      ${meetings.length ? `
        <div class="list">
          ${meetings.map((match) => `
            <div class="match-row">
              <span class="faint">${match.date.slice(0, 7)}</span>
              <span class="team-inline">${flag(match.home)}<span>${match.home}</span></span>
              <span class="center-score">${match.hg}-${match.ag}</span>
              <span class="team-inline">${flag(match.away)}<span>${match.away}</span></span>
              <span></span>
            </div>
          `).join("")}
        </div>
      ` : `<div class="empty">No recent meetings in the bundled match history.</div>`}
    </div>
  `;
}

function renderSchedule(ratings) {
  const results = resultMap();
  const grouped = groupBy(state.data.schedule, (match) => match.date);
  return `
    <section class="panel pad">
      <div class="section-head">
        <div>
          <div class="label">Schedule</div>
          <h2>All 104 matches</h2>
        </div>
        <p>Played matches show the final score. Future group matches show model favourites and can be opened in Predict.</p>
      </div>
      ${Object.entries(grouped).map(([date, matches]) => `
        <div class="timeline-day">
          <div class="timeline-title">
            <h3>${formatDate(date)}</h3>
            <span class="tag">${matches.length} match${matches.length === 1 ? "" : "es"}</span>
          </div>
          <div class="list">
            ${matches.map((match) => renderScheduleMatch(match, results.get(match.id), ratings)).join("")}
          </div>
        </div>
      `).join("")}
    </section>
  `;
}

function renderScheduleMatch(match, result, ratings) {
  const canPick = !result && !match.homeTbd && !match.awayTbd;
  const home = state.data.teamByName[match.home];
  const away = state.data.teamByName[match.away];
  let status = "TBD";
  if (result) {
    status = "FT";
  } else if (canPick) {
    const prediction = matchPrediction(match.home, match.away, ratings);
    const fav = prediction.pHome >= prediction.pAway ? home : away;
    status = `${fav.code} ${pct(Math.max(prediction.pHome, prediction.pAway), 0)}`;
  } else {
    status = match.stage === "group" ? "TBD" : "projected in Bracket";
  }
  const tag = `${STAGE_LABELS[match.stage]}${match.group ? ` · Group ${match.group}` : ""}`;
  const homeLabel = home ? `${home.flag}<span>${home.name}</span>` : `<span>${match.home}</span>`;
  const awayLabel = away ? `${away.flag}<span>${away.name}</span>` : `<span>${match.away}</span>`;
  return `
    <button class="match-button" ${canPick ? `data-pick="${escapeAttr(match.home)}|${escapeAttr(match.away)}"` : "disabled"}>
      <span class="stage-chip">${tag}</span>
      <span class="team-inline">${homeLabel}</span>
      <span class="center-score">${result ? `${result.homeGoals}-${result.awayGoals}` : "v"}</span>
      <span class="team-inline">${awayLabel}</span>
      <span class="tag">${status}</span>
      <span class="faint" style="grid-column:1 / -1">${localFixtureTime(match)} · ${match.venue} · ${match.time} local listing</span>
    </button>
  `;
}

function renderProps(sim) {
  const blended = blendedChampionProb(sim, state.data.odds, state.config.marketBlend);
  const focus = state.data.teamByName[state.home] || state.data.teams[0];
  const focusStats = sim.teamStatsByName.get(focus.name);
  return `
    <section class="panel pad">
      <div class="section-head">
        <div>
          <div class="label">Pre-tournament</div>
          <h2>Call-your-shot probabilities</h2>
        </div>
        <p>The original page locked a 30,000-run pre-tournament snapshot. This version keeps that view and also shows the live model blended with the outright market.</p>
      </div>
      <div class="grid four">
        ${metric("Model favourite", `${sim.championProb[0].team.flag} ${sim.championProb[0].team.name}`, pct(sim.championProb[0].p, 1), "accent-green")}
        ${metric("Market blend", `${state.config.marketBlend}%`, state.data.odds.source, "accent-cyan")}
        ${metric("Top scorer goals", sim.avgTopScorer.toFixed(1), "mean tournament leader", "accent-amber")}
        ${metric("0-0 matches", sim.avgZeroZero.toFixed(1), "mean tournament count", "accent-violet")}
      </div>
    </section>
    <div class="grid two" style="margin-top:14px">
      <section class="panel pad">
        <div class="section-head">
          <div>
            <div class="label">Champion table</div>
            <h2>Model x market</h2>
          </div>
        </div>
        <table>
          <thead><tr><th>Team</th><th class="num">Blend</th><th class="num">Model</th><th class="num">Market</th></tr></thead>
          <tbody>
            ${blended.slice(0, 16).map((row) => `
              <tr>
                <td>${row.team.flag} ${row.team.name}</td>
                <td class="num"><strong>${pct(row.blended, 1)}</strong></td>
                <td class="num">${pct(row.model, 1)}</td>
                <td class="num">${pct(row.market, 1)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </section>
      <section class="panel pad">
        <div class="section-head">
          <div>
            <div class="label">Focus team</div>
            <h2>${focus.flag} ${focus.name}</h2>
          </div>
          ${teamSelect("home", focus.name)}
        </div>
        <div class="grid two">
          ${metric("Advance", pct(focusStats.advance, 1), "top two or best third", "accent-green")}
          ${metric("Win group", pct(focusStats.groupWin, 1), `Group ${focus.group}`, "accent-cyan")}
          ${metric("Semi-final", pct(focusStats.semi, 1), "reach last four", "accent-amber")}
          ${metric("Champion", pct(focusStats.winner, 1), "lift trophy", "accent-violet")}
        </div>
        <div style="margin-top:14px">
          <div class="label">Goals distribution</div>
          ${renderDistribution([...focusStats.goalDist.entries()].map(([value, count]) => ({ value, p: count / sim.runs })).sort((a, b) => a.value - b.value), "goals")}
        </div>
      </section>
    </div>
    <div class="grid two" style="margin-top:14px">
      <section class="panel pad">
        <div class="section-head"><div><div class="label">Golden Boot prop</div><h2>Top scorer total</h2></div></div>
        ${renderDistribution(sim.topScorerDist, "goals")}
      </section>
      <section class="panel pad">
        <div class="section-head"><div><div class="label">Tournament prop</div><h2>How many 0-0s?</h2></div></div>
        ${renderDistribution(sim.zeroZeroDist, "matches")}
      </section>
    </div>
    ${renderControls()}
  `;
}

function renderGroups(ratings, sim) {
  const standings = currentStandings();
  return `
    <section class="panel pad">
      <div class="section-head">
        <div>
          <div class="label">Groups</div>
          <h2>Live tables and advance probabilities</h2>
        </div>
        <p>Tables use actual results. Advancement probabilities simulate the remaining group schedule, best-third qualification, and the official bracket.</p>
      </div>
      <div class="group-grid">
        ${GROUPS.map((group) => renderGroupTable(group, standings, ratings, sim)).join("")}
      </div>
    </section>
  `;
}

function renderGroupTable(group, standings, ratings, sim) {
  const rows = groupRows(group, standings, ratings);
  return `
    <div class="panel flat pad">
      <div class="section-head"><h3>Group ${group}</h3><span class="tag">Adv</span></div>
      <table class="standings-table">
        <thead><tr><th>Team</th><th class="num">P</th><th class="num">GD</th><th class="num">Pts</th><th class="num">Adv</th></tr></thead>
        <tbody>
          ${rows.map((row, index) => {
            const stat = sim.teamStatsByName.get(row.team.name);
            const cls = index < 2 ? "rank-good" : index === 2 ? "rank-third" : "";
            return `
              <tr>
                <td class="${cls}">${row.team.flag} ${row.team.name}</td>
                <td class="num">${row.played}</td>
                <td class="num">${signed(row.gd)}</td>
                <td class="num">${row.pts}</td>
                <td class="num"><strong>${pct(stat.advance, 0)}</strong></td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderBracket(projection) {
  const rounds = [
    ["round32", "Round of 32"],
    ["round16", "Round of 16"],
    ["quarter", "Quarter-finals"],
    ["semi", "Semi-finals"],
    ["final", "Final"],
  ];
  const final = projection.games.find((game) => game.stage === "final");
  return `
    <section class="panel pad">
      <div class="section-head">
        <div>
          <div class="label">Projected bracket</div>
          <h2>${final?.winner?.flag || ""} ${final?.winner?.name || "TBD"} projected champion</h2>
        </div>
        <button class="primary-button" data-action="copy-bracket">${state.copied ? "Copied" : "Copy bracket"}</button>
      </div>
      <p class="muted" style="margin-bottom:14px">Single path: current results plus favourite/mode scorelines for unplayed group matches, official best-third slot constraints, then favourite/mode knockout results.</p>
      ${state.copyFallback ? `
        <div class="panel flat pad" style="margin-bottom:14px;background:var(--panel-2)">
          <div class="label">Bracket text</div>
          <textarea readonly style="width:100%;height:180px;margin-top:8px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--text);padding:10px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(state.bracketText)}</textarea>
        </div>
      ` : ""}
      <div class="bracket">
        ${rounds.map(([stage, title]) => `
          <div class="round">
            <div class="round-title">${title}</div>
            ${projection.games.filter((game) => game.stage === stage).map(renderBracketGame).join("")}
          </div>
        `).join("")}
      </div>
      <div style="margin-top:14px;max-width:320px">
        <div class="round-title">Third-place play-off</div>
        ${projection.games.filter((game) => game.stage === "third").map(renderBracketGame).join("")}
      </div>
    </section>
  `;
}

function renderBracketGame(game) {
  return `
    <div class="bracket-game">
      ${bracketTeam(game.homeTeam, game.homeGoals, game.winner.name === game.homeTeam.name, game.pens)}
      ${bracketTeam(game.awayTeam, game.awayGoals, game.winner.name === game.awayTeam.name, game.pens)}
    </div>
  `;
}

function bracketTeam(team, goals, winner, pens) {
  return `
    <div class="bracket-team ${winner ? "win" : ""}">
      <span class="team-inline">${team.flag}<span>${team.name}${winner && pens ? " (P)" : ""}</span></span>
      <span>${goals}</span>
    </div>
  `;
}

function renderRatings(ratings) {
  const rows = state.data.teams
    .map((team) => ({ team, elo: ratingOf(team, ratings), delta: ratingOf(team, ratings) - team.prior }))
    .sort((a, b) => b.elo - a.elo);
  const maxDelta = Math.max(1, ...rows.map((row) => Math.abs(row.delta)));
  return `
    <section class="panel pad">
      <div class="section-head">
        <div>
          <div class="label">Ratings</div>
          <h2>Live Elo table</h2>
        </div>
        <p>Ratings start from international Elo priors and update from the bundled World Cup results with margin-of-victory scaling.</p>
      </div>
      <table>
        <thead><tr><th>#</th><th>Team</th><th>Grp</th><th class="num">Elo</th><th class="num">Prior</th><th class="num">Delta</th><th>Movement</th></tr></thead>
        <tbody>
          ${rows.map((row, index) => `
            <tr>
              <td>${index + 1}</td>
              <td>${row.team.flag} ${row.team.name}${row.team.host ? ` <span class="tag">Host</span>` : ""}</td>
              <td>${row.team.group}</td>
              <td class="num"><strong>${Math.round(row.elo)}</strong></td>
              <td class="num">${row.team.prior}</td>
              <td class="num ${row.delta > 0.5 ? "accent-green" : row.delta < -0.5 ? "accent-rose" : "faint"}">${signed(Math.round(row.delta))}</td>
              <td>${movementBar(row.delta, maxDelta)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </section>
  `;
}

function movementBar(delta, maxDelta) {
  const width = Math.abs(delta) / maxDelta * 50;
  return `
    <div style="position:relative;width:128px;height:9px;border-radius:999px;background:var(--line-soft);overflow:hidden">
      <span style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:var(--faint)"></span>
      <span style="position:absolute;${delta >= 0 ? "left:50%" : `right:50%`};top:0;bottom:0;width:${width}%;background:${delta >= 0 ? "var(--green)" : "var(--rose)"}"></span>
    </div>
  `;
}

function renderResults() {
  const graded = gradePredictions(state.data.results);
  if (!graded.length) return `<div class="empty">No matches played yet.</div>`;
  return `
    <div class="grid two">
      <section class="panel pad">
        <div class="section-head">
          <div><div class="label">Golden Boot race</div><h2>Current scorers</h2></div>
          <span class="tag">excl. shootouts</span>
        </div>
        ${renderScorers()}
      </section>
      <section class="panel pad">
        <div class="section-head">
          <div><div class="label">Results</div><h2>Prediction scorecard</h2></div>
        </div>
        <div class="list">
          ${[...graded].reverse().map(renderResultCard).join("")}
        </div>
      </section>
    </div>
  `;
}

function renderScorers() {
  const max = Math.max(1, ...state.data.scorers.map((row) => row.goals));
  return `
    <div class="list">
      ${state.data.scorers.slice(0, 12).map((row, index) => `
        <div class="match-row">
          <span class="faint">#${index + 1}</span>
          <span class="team-inline">${flag(row.team)}<span>${row.name}</span></span>
          <span class="center-score">${row.goals}</span>
          <span class="muted">${row.team}</span>
          <span class="bar"><span class="bar-amber" style="width:${row.goals / max * 100}%;background:var(--amber)"></span></span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderResultCard(row) {
  const match = row.match;
  const home = state.data.teamByName[match.home];
  const away = state.data.teamByName[match.away];
  return `
    <div class="panel flat pad">
      <div class="section-head">
        <span class="stage-chip">${STAGE_LABELS[match.stage]}${match.group ? ` · Group ${match.group}` : ""} · ${match.date}</span>
        <span class="tag ${row.correct ? "accent-green" : "accent-amber"}">${row.correct ? "called it" : "missed"} · picked ${row.picked === "draw" ? "draw" : row.picked === "home" ? home.code : away.code}</span>
      </div>
      <div class="match-row">
        <span></span>
        <span class="team-inline">${home.flag}<span>${home.name}</span></span>
        <span class="center-score">${match.homeGoals}-${match.awayGoals}</span>
        <span class="team-inline">${away.flag}<span>${away.name}</span></span>
        <strong>P(actual) ${pct(row.pActual, 1)}</strong>
      </div>
      <div class="bar" style="margin-top:10px">
        <span class="bar-home" style="width:${row.prediction.pHome * 100}%"></span>
        <span class="bar-draw" style="width:${row.prediction.pDraw * 100}%"></span>
        <span class="bar-away" style="width:${row.prediction.pAway * 100}%"></span>
      </div>
      <p class="faint" style="margin-top:8px">${home.code} ${pct(row.prediction.pHome, 0)} · Draw ${pct(row.prediction.pDraw, 0)} · ${away.code} ${pct(row.prediction.pAway, 0)}</p>
    </div>
  `;
}

function renderAccuracy() {
  const graded = gradePredictions(state.data.results);
  const scores = accuracyScores(graded);
  return `
    <section class="panel pad">
      <div class="section-head">
        <div><div class="label">Accuracy</div><h2>How the model is scoring</h2></div>
        <p>Brier score and log-loss compare the pre-match probability distribution with the actual outcome. Lower is better for both.</p>
      </div>
      <div class="grid four">
        ${metric("Matches graded", scores.n, "completed fixtures", "accent-green")}
        ${metric("Hit rate", pct(scores.hitRate, 0), "modal outcome correct", "accent-cyan")}
        ${metric("Brier score", scores.brier.toFixed(3), "multiclass, 0 to 2", "accent-amber")}
        ${metric("Log-loss", scores.logLoss.toFixed(3), "mean -ln P(actual)", "accent-violet")}
      </div>
    </section>
    <section class="panel pad" style="margin-top:14px">
      <div class="section-head"><div><div class="label">Calibration over time</div><h2>Mean log-loss trend</h2></div></div>
      ${renderSparkline(scores.trend)}
      <p class="muted">A naive three-way coin flip has log-loss about 1.10 and Brier about 0.67. The current model is ${scores.logLoss < 1.1 ? "ahead of" : "behind"} that baseline.</p>
    </section>
  `;
}

function renderSingaporePools(ratings) {
  const feed = state.data.singaporePools || defaultSingaporePoolsFeed();
  const events = singaporePoolsWorldCupEvents(feed);
  const upcoming = singaporePoolsWatchlist(ratings, events);
  const listedMarketCount = events.reduce((sum, event) => sum + (Array.isArray(event.markets) ? event.markets.length : 0), 0);
  const sourceState = listedMarketCount
    ? `${listedMarketCount} listed market${listedMarketCount === 1 ? "" : "s"}`
      : events.length
        ? `${events.length} public event hint${events.length === 1 ? "" : "s"}`
      : feed.generatedAt
        ? "Checked, no public listings"
        : "No public World Cup listing";
  return `
    <section class="panel pad">
      <div class="section-head">
        <div>
          <div class="label">Singapore Pools</div>
          <h2>World Cup market watch</h2>
        </div>
        <p>Informational price comparison only. It does not place bets, size stakes, or tell you to gamble. Singapore Pools says its games are for safer play, under-18 betting is not allowed, and account betting is only for people above 21.</p>
      </div>
      <div class="grid four">
        ${metric("Source", "SG Pools", sourceState, "accent-green")}
        ${metric("Snapshot", feed.generatedAt ? formatSnapshotTime(feed.generatedAt) : "Not connected", "read from data/sgpools-markets.json", "accent-cyan")}
        ${metric("Markets known", SG_POOLS_BET_TYPES.length, "football bet-type catalogue", "accent-amber")}
        ${metric("Mode", "Availability", "public listings + model fair odds", "accent-violet")}
      </div>
      <p class="muted" style="margin-top:12px;line-height:1.5">
        The daily updater writes public Singapore Pools World Cup listing hints into <code>data/sgpools-markets.json</code>. Live prices are intentionally not fetched; this page shows availability context and the predictor's own fair odds.
      </p>
      <div class="team-meta" style="margin-top:12px">
        <a class="pill" href="https://online.singaporepools.com/en/sports" target="_blank" rel="noreferrer noopener">Open Singapore Pools sports</a>
        <a class="pill" href="https://online.singaporepools.com/en/sports/football-bet-types" target="_blank" rel="noreferrer noopener">Football bet types</a>
      </div>
    </section>
    <div class="grid two" style="margin-top:14px">
      <section class="panel pad">
        <div class="section-head">
          <div>
            <div class="label">Available at snapshot</div>
            <h2>${events.length ? "World Cup listings found" : "Waiting for public listings"}</h2>
          </div>
        </div>
        ${events.length ? renderSingaporePoolsEvents(events, ratings) : renderSingaporePoolsEmpty(feed)}
      </section>
      <section class="panel pad">
        <div class="section-head">
          <div>
            <div class="label">Market catalogue</div>
            <h2>Singapore football bet types</h2>
          </div>
        </div>
        <div class="team-meta">
          ${SG_POOLS_BET_TYPES.map(([code, name]) => `<span class="tag">${code} · ${name}</span>`).join("")}
        </div>
        <p class="muted" style="margin-top:12px;line-height:1.5">The model can directly estimate 1X2, Over/Under 2.5, Both Teams Score, and Pick the Score. Singapore Pools market names are shown for availability context only.</p>
      </section>
    </div>
    <section class="panel pad" style="margin-top:14px">
      <div class="section-head">
        <div>
          <div class="label">Upcoming World Cup watchlist</div>
          <h2>Model fair prices for comparable markets</h2>
        </div>
        <p>Fair odds are 1 divided by model probability. They are generated by this predictor only and are not Singapore Pools prices or recommendations.</p>
      </div>
      <div class="list">
        ${upcoming.map((item) => renderSingaporePoolsWatchCard(item)).join("")}
      </div>
    </section>
  `;
}

function singaporePoolsWorldCupEvents(feed) {
  const events = Array.isArray(feed.events) ? feed.events : [];
  return events.filter((event) => {
    const text = `${event.competition || ""} ${event.league || ""} ${event.tournament || ""} ${event.home || ""} ${event.away || ""}`.toLowerCase();
    return text.includes("world cup") || text.includes("w cup") || text.includes("wcup") || matchByTeams(event.home, event.away);
  });
}

function singaporePoolsWatchlist(ratings, sgEvents) {
  const played = new Set(state.data.results.map((result) => result.id));
  return state.data.schedule
    .filter((match) => match.stage === "group" && !played.has(match.id) && !match.homeTbd && !match.awayTbd)
    .slice(0, 12)
    .map((match) => {
      const prediction = matchPrediction(match.home, match.away, ratings);
      const event = sgEvents.find((candidate) => matchByTeams(candidate.home, candidate.away, match.home, match.away));
      return {
        match,
        prediction,
        event,
        comparisons: modelComparableMarkets(prediction, match),
      };
    });
}

function renderSingaporePoolsEvents(events, ratings) {
  return `
    <div class="list">
      ${events.map((event) => {
        const match = findFixtureByTeams(event.home, event.away);
        const prediction = match ? matchPrediction(match.home, match.away, ratings) : null;
        const markets = Array.isArray(event.markets) ? event.markets : [];
        return `
          <div class="panel flat pad">
            <div class="section-head">
              <div>
                <h3>${escapeHtml(event.home || "TBD")} vs ${escapeHtml(event.away || "TBD")}</h3>
                <span class="muted">${event.kickoff ? escapeHtml(formatSnapshotTime(event.kickoff)) : "Kickoff TBC"} · ${escapeHtml(event.competition || event.tournament || "Football")}</span>
              </div>
              <span class="tag">${escapeHtml(event.status || "available")}</span>
            </div>
            <div class="team-meta">${markets.map((market) => `<span class="tag">${escapeHtml(market.code || "")} ${escapeHtml(market.name || "Market")}</span>`).join("") || `<span class="tag">No market list supplied</span>`}</div>
            ${prediction ? renderMarketComparisonTable(modelComparableMarkets(prediction, match)) : `<p class="muted" style="margin-top:10px">Could not match this event to the World Cup schedule, so model fair odds are not shown.</p>`}
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderSingaporePoolsEmpty(feed) {
  const checkedAt = feed.generatedAt ? formatSnapshotTime(feed.generatedAt) : null;
  return `
    <div class="empty" style="text-align:left">
      <strong>${checkedAt ? "No public Singapore Pools World Cup listings were found at the last check." : "Singapore Pools updater has not run yet."}</strong>
      <p style="margin-top:8px">${checkedAt ? `Last checked: ${escapeHtml(checkedAt)}.` : "Run the updater to create the first market snapshot."}</p>
      <p style="margin-top:8px">${escapeHtml(feed.note || "The updater checks public Singapore Pools pages for World Cup listing hints.")}</p>
    </div>
  `;
}

function renderSingaporePoolsWatchCard(item) {
  const home = state.data.teamByName[item.match.home];
  const away = state.data.teamByName[item.match.away];
  return `
    <div class="panel flat pad">
      <div class="section-head">
        <div>
          <h3>${home.flag} ${home.name} vs ${away.flag} ${away.name}</h3>
          <span class="muted">${localFixtureTime(item.match)} · ${item.match.venue}</span>
        </div>
        <span class="tag">${item.event ? "Public SG listing" : "No public SG listing"}</span>
      </div>
      ${renderMarketComparisonTable(item.comparisons)}
    </div>
  `;
}

function renderMarketComparisonTable(comparisons) {
  return `
    <div class="matrix-wrap" style="margin-top:10px">
      <table>
        <thead>
          <tr><th>Market</th><th>Selection</th><th class="num">Model</th><th class="num">Fair odds</th><th>Status</th></tr>
        </thead>
        <tbody>
          ${comparisons.map((row) => `
            <tr>
              <td>${row.market}</td>
              <td>${row.selection}</td>
              <td class="num">${row.probability != null ? pct(row.probability, 1) : "--"}</td>
              <td class="num">${row.fairOdds ? row.fairOdds.toFixed(2) : "--"}</td>
              <td>Model only</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function modelComparableMarkets(prediction, match) {
  const home = state.data.teamByName[match.home];
  const away = state.data.teamByName[match.away];
  const rows = [
    marketRow("1X2", home.name, prediction.pHome),
    marketRow("1X2", "Draw", prediction.pDraw),
    marketRow("1X2", away.name, prediction.pAway),
    marketRow("Over/Under 2.5", "Over 2.5", prediction.over25),
    marketRow("Over/Under 2.5", "Under 2.5", 1 - prediction.over25),
    marketRow("Both Teams Score", "Yes", prediction.btts),
    marketRow("Both Teams Score", "No", 1 - prediction.btts),
  ];
  prediction.topScorelines.slice(0, 3).forEach((score) => {
    rows.push(marketRow("Pick the Score", `${score.h}-${score.a}`, score.p));
  });
  return rows;
}

function compareSingaporePoolsMarkets(event, prediction, match) {
  const base = modelComparableMarkets(prediction, match);
  const markets = Array.isArray(event.markets) ? event.markets : [];
  return base.map((row) => {
    const selection = findSingaporePoolsSelection(markets, row.market, row.selection);
    if (!selection) return row;
    const listedOdds = Number(selection.odds || selection.price || selection.decimalOdds);
    return {
      ...row,
      listedOdds: Number.isFinite(listedOdds) ? listedOdds : null,
      available: selection.available !== false && selection.suspended !== true,
      edge: Number.isFinite(listedOdds) ? row.probability * listedOdds - 1 : null,
    };
  });
}

function findSingaporePoolsSelection(markets, marketName, selectionName) {
  const wantedMarket = normalizeMarketName(marketName);
  const wantedSelection = normalizeMarketName(selectionName);
  for (const market of markets) {
    const marketText = normalizeMarketName(`${market.code || ""} ${market.name || ""}`);
    if (!marketText.includes(wantedMarket) && !wantedMarket.includes(marketText.replace(/mr|hl|bg|cs/g, "").trim())) continue;
    const selections = Array.isArray(market.selections) ? market.selections : [];
    const match = selections.find((selection) => normalizeMarketName(`${selection.name || ""} ${selection.label || ""} ${selection.code || ""}`).includes(wantedSelection));
    if (match) return match;
  }
  return null;
}

function marketRow(market, selection, probability) {
  const fairOdds = probability > 0 ? 1 / probability : null;
  return {
    market,
    selection,
    probability,
    fairOdds,
    listedOdds: null,
    edge: null,
    available: false,
  };
}

function matchByTeams(aHome, aAway, bHome, bAway) {
  if (!aHome || !aAway) return false;
  if (!bHome || !bAway) {
    return Boolean(findFixtureByTeams(aHome, aAway));
  }
  const left = [normalizeTeamName(aHome), normalizeTeamName(aAway)].sort().join("|");
  const right = [normalizeTeamName(bHome), normalizeTeamName(bAway)].sort().join("|");
  return left === right;
}

function findFixtureByTeams(home, away) {
  return state.data.schedule.find((match) => !match.homeTbd && !match.awayTbd && matchByTeams(home, away, match.home, match.away));
}

function normalizeTeamName(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/republic of korea/g, "korea republic")
    .replace(/usa|u\.s\.a\.|united states of america/g, "united states")
    .replace(/czech republic/g, "czechia")
    .replace(/ivory coast/g, "cote d'ivoire")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeMarketName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/over under/g, "over/under")
    .replace(/total goals over\/under|hl/g, "over/under 2.5")
    .replace(/will both teams score|bg/g, "both teams score")
    .replace(/pick the score|cs/g, "pick the score")
    .replace(/1x2|mr/g, "1x2")
    .replace(/[^a-z0-9./]+/g, " ")
    .trim();
}

function formatSnapshotTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-SG", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Singapore",
  }).format(date);
}

function renderMethod(ratings, sim) {
  const top = sim.championProb[0];
  return `
    <section class="panel pad">
      <div class="section-head">
        <div><div class="label">Method</div><h2>Elo + Poisson + Monte Carlo</h2></div>
        <p>This is the working model behind every tab. Change the controls and the match odds, group probabilities, and bracket simulation recompute together.</p>
      </div>
      <div class="grid four">
        ${metric("Current leader", `${top.team.flag} ${top.team.name}`, pct(top.p, 1), "accent-green")}
        ${metric("Runs", fmtInt(sim.runs), "Monte Carlo tournaments", "accent-cyan")}
        ${metric("Host boost", state.config.hostBoost, "Elo points for USA/MEX/CAN", "accent-amber")}
        ${metric("Upset noise", state.config.upsetNoise, "per-match rating variance", "accent-violet")}
      </div>
    </section>
    ${renderControls()}
    <div class="grid two" style="margin-top:14px">
      <section class="panel pad">
        <div class="section-head"><div><div class="label">Formula stack</div><h2>How a match is priced</h2></div></div>
        <table>
          <tbody>
            <tr><th>Elo update</th><td>New Elo = old Elo + K x margin factor x (actual - expected)</td></tr>
            <tr><th>Strength</th><td>Effective Elo adds host boost, optional home edge, form style, and simulation noise.</td></tr>
            <tr><th>Goals</th><td>xG = base xG x exp(Elo gap / scale) x attack/defense style multiplier.</td></tr>
            <tr><th>Scoreline</th><td>Poisson goal distributions are adjusted for low-score dependence and 0-0 inflation.</td></tr>
            <tr><th>Draws</th><td>A closeness curve nudges draw probability upward when teams are similarly rated.</td></tr>
            <tr><th>Tournament</th><td>Groups include played results, simulate remaining fixtures, assign best thirds, then play the official knockout tree.</td></tr>
          </tbody>
        </table>
      </section>
      <section class="panel pad">
        <div class="section-head"><div><div class="label">Model inputs</div><h2>Top live ratings</h2></div></div>
        <table>
          <thead><tr><th>Team</th><th class="num">Elo</th><th class="num">Title</th></tr></thead>
          <tbody>
            ${[...state.data.teams].sort((a, b) => ratingOf(b, ratings) - ratingOf(a, ratings)).slice(0, 12).map((team) => {
              const stat = sim.teamStatsByName.get(team.name);
              return `<tr><td>${team.flag} ${team.name}</td><td class="num">${Math.round(ratingOf(team, ratings))}</td><td class="num">${pct(stat.winner, 1)}</td></tr>`;
            }).join("")}
          </tbody>
        </table>
      </section>
    </div>
  `;
}

function renderControls() {
  const c = state.config;
  return `
    <section class="panel pad" style="margin-top:14px">
      <div class="section-head">
        <div><div class="label">Model controls</div><h2>Simulation settings</h2></div>
        <button class="primary-button" data-action="reset-config">Reset</button>
      </div>
      <div class="control-grid">
        ${control("runs", "Runs", c.runs, 2000, 50000, 1000, fmtInt(c.runs))}
        ${control("hostBoost", "Host boost", c.hostBoost, 0, 120, 5, c.hostBoost)}
        ${control("styleWeight", "Style weight", c.styleWeight, 0, 150, 5, `${c.styleWeight}%`)}
        ${control("drawGuard", "Draw guard", c.drawGuard, 0, 30, 1, `${c.drawGuard}%`)}
        ${control("marketBlend", "Market blend", c.marketBlend, 0, 100, 5, `${c.marketBlend}%`)}
        ${control("upsetNoise", "Upset noise", c.upsetNoise, 0, 80, 2, c.upsetNoise)}
        ${control("baseXg", "Base xG", c.baseXg, 1.0, 1.8, 0.05, c.baseXg.toFixed(2))}
        ${control("xgScale", "Elo to xG scale", c.xgScale, 360, 760, 20, c.xgScale)}
        ${control("zeroInflation", "0-0 inflation", c.zeroInflation, 0, 0.8, 0.05, c.zeroInflation.toFixed(2))}
        ${control("rho", "Low-score rho", c.rho, -0.2, 0.1, 0.01, c.rho.toFixed(2))}
      </div>
    </section>
  `;
}

function control(key, label, value, min, max, step, output) {
  return `
    <div class="control">
      <label><span>${label}</span><output>${output}</output></label>
      <input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-control="${key}">
    </div>
  `;
}

function metric(label, value, sub, accent = "accent-green") {
  return `
    <div class="metric">
      <div class="label">${label}</div>
      <div class="value ${accent}">${value}</div>
      <div class="sub">${sub}</div>
    </div>
  `;
}

function renderDistribution(dist, suffix) {
  const max = Math.max(0.01, ...dist.map((row) => row.p));
  return `
    <div class="list" style="margin-top:10px">
      ${dist.filter((row) => row.p > 0.003).slice(0, 12).map((row) => `
        <div class="match-row">
          <span class="faint">${row.value} ${suffix}</span>
          <span class="bar" style="grid-column:2 / 5"><span class="bar-cyan" style="width:${row.p / max * 100}%;background:var(--cyan)"></span></span>
          <strong>${pct(row.p, 1)}</strong>
        </div>
      `).join("")}
    </div>
  `;
}

function renderSparkline(points) {
  if (points.length < 2) return `<div class="empty">Need at least two completed matches to plot a trend.</div>`;
  const w = 760;
  const h = 110;
  const min = Math.min(...points, 1.1);
  const max = Math.max(...points, 1.1);
  const span = max - min || 1;
  const x = (index) => (index / (points.length - 1)) * w;
  const y = (value) => h - 12 - ((value - min) / span) * (h - 24);
  const path = points.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(1)} ${y(value).toFixed(1)}`).join(" ");
  const baseline = y(1.1);
  return `
    <svg class="sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Log-loss trend">
      <line x1="0" x2="${w}" y1="${baseline}" y2="${baseline}" stroke="var(--faint)" stroke-dasharray="5 5"></line>
      <path d="${path}" fill="none" stroke="var(--cyan)" stroke-width="3" vector-effect="non-scaling-stroke"></path>
      <circle cx="${x(points.length - 1)}" cy="${y(points.at(-1))}" r="4" fill="var(--cyan)"></circle>
    </svg>
  `;
}

function renderFooter() {
  return `
    <footer class="footer">
      Built from the inspected predictor's complete function set: match predictor, schedule, pre-tournament props, groups, bracket, ratings, results, and accuracy.
      Data files are bundled locally from the public GitHub Pages app snapshot inspected on June 13, 2026.
    </footer>
  `;
}

function bindEvents() {
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      location.hash = button.dataset.tab;
    });
  });

  document.querySelectorAll("[data-select]").forEach((select) => {
    select.addEventListener("change", () => {
      if (select.dataset.select === "home") state.home = select.value;
      if (select.dataset.select === "away") state.away = select.value;
      render();
    });
  });

  document.querySelectorAll("[data-control]").forEach((input) => {
    input.addEventListener("change", () => {
      const key = input.dataset.control;
      state.config[key] = Number(input.value);
      saveConfig();
      render();
    });
  });

  document.querySelectorAll("[data-pick]").forEach((button) => {
    button.addEventListener("click", () => {
      const [home, away] = button.dataset.pick.split("|");
      state.home = home;
      state.away = away;
      location.hash = "predict";
      render();
    });
  });

  document.querySelectorAll("[data-action='theme']").forEach((button) => {
    button.addEventListener("click", () => {
      document.documentElement.classList.toggle("light");
      localStorage.setItem("wc26-theme", document.documentElement.classList.contains("light") ? "light" : "dark");
      render();
    });
  });

  document.querySelectorAll("[data-action='reset-config']").forEach((button) => {
    button.addEventListener("click", () => {
      state.config = { ...DEFAULT_CONFIG };
      saveConfig();
      render();
    });
  });

  document.querySelectorAll("[data-action='copy-bracket']").forEach((button) => {
    button.addEventListener("click", async () => {
      const ratings = ratingsAfterResults(state.data.results);
      const projection = deterministicProjection(ratings);
      const text = bracketText(projection.games);
      const copied = await writeClipboardText(text);
      if (copied) {
        state.copyFallback = false;
        state.copied = true;
        render();
        setTimeout(() => {
          state.copied = false;
          render();
        }, 1400);
      } else {
        state.bracketText = text;
        state.copyFallback = true;
        render();
      }
    });
  });
}

async function writeClipboardText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (error) {}
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch (error) {
    copied = false;
  }
  textarea.remove();
  return copied;
}

function bracketText(games) {
  const final = games.find((game) => game.stage === "final");
  const lines = [`World Cup 2026 Predictor bracket`, `Champion: ${final?.winner?.name || "TBD"}`, ""];
  for (const stage of ["round32", "round16", "quarter", "semi", "final", "third"]) {
    lines.push(STAGE_LABELS[stage].toUpperCase());
    for (const game of games.filter((row) => row.stage === stage)) {
      lines.push(`${game.homeTeam.name} ${game.homeGoals}-${game.awayGoals} ${game.awayTeam.name} (${game.winner.name}${game.pens ? ", pens" : ""})`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function matchRead(home, away, prediction) {
  const top = [
    [home.name, prediction.pHome],
    ["draw", prediction.pDraw],
    [away.name, prediction.pAway],
  ].sort((a, b) => b[1] - a[1])[0];
  const gap = Math.abs(prediction.ratingDiff);
  const drawNote = prediction.pDraw > 0.28 ? "The draw is live because the adjusted strength gap is narrow." : "The draw sits in the background but is not the leading outcome.";
  return `${top[0]} is the model lean at ${pct(top[1], 0)}. The effective Elo gap is ${Math.round(gap)} points after host, form, and style adjustments. ${drawNote}`;
}

function recentForm(team, count = 5) {
  const form = [];
  for (const match of state.data.history) {
    if (match.home !== team && match.away !== team) continue;
    const isHome = match.home === team;
    const gf = isHome ? match.hg : match.ag;
    const ga = isHome ? match.ag : match.hg;
    form.push({ result: gf > ga ? "W" : gf < ga ? "L" : "D", gf, ga, opp: isHome ? match.away : match.home, date: match.date });
    if (form.length >= count) break;
  }
  return form;
}

function localFixtureTime(match) {
  const parsed = parseKickoff(match.date, match.time);
  if (!parsed) return `${formatDate(match.date)} · ${match.time}`;
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(parsed);
}

function parseKickoff(date, time) {
  const match = time.match(/(\d{1,2}):(\d{2}) UTC([+-]\d+)/);
  if (!match) return null;
  const [, hh, mm, offset] = match;
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, Number(hh) - Number(offset), Number(mm)));
}

function formatDate(date) {
  const parsed = new Date(`${date}T00:00:00Z`);
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "2-digit", month: "short" }).format(parsed);
}

function groupBy(items, fn) {
  return items.reduce((acc, item) => {
    const key = fn(item);
    (acc[key] ||= []).push(item);
    return acc;
  }, {});
}

function ratingOf(team, ratings) {
  return ratings.get(team.name) || team.prior;
}

function flag(teamName) {
  return state.data.teamByName[teamName]?.flag || "";
}

function pct(value, digits = 0) {
  return `${(value * 100).toFixed(digits)}%`;
}

function signed(value) {
  return value > 0 ? `+${value}` : `${value}`;
}

function fmtInt(value) {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeAttr(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function random() {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(random) {
  let u = 0;
  let v = 0;
  while (u === 0) u = random();
  while (v === 0) v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function poissonSample(lambda, random) {
  const limit = Math.exp(-lambda);
  let product = 1;
  let k = 0;
  do {
    k += 1;
    product *= random();
  } while (product > limit);
  return k - 1;
}
