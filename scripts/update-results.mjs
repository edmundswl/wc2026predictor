#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEDULE_FILE = resolve(ROOT, "data/schedule.json");
const RESULTS_FILE = resolve(ROOT, "data/results.json");
const ESPN_SCOREBOARD =
  "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";

const TEAM_ALIASES = new Map([
  ["bosnia herzegovina", "bosnia and herzegovina"],
  ["bosnia and herzegovina", "bosnia and herzegovina"],
  ["bosniaherzegovina", "bosnia and herzegovina"],
  ["south korea", "korea republic"],
  ["republic of korea", "korea republic"],
  ["korea republic", "korea republic"],
  ["czech republic", "czechia"],
  ["czechia", "czechia"],
  ["turkey", "turkiye"],
  ["turkiye", "turkiye"],
  ["türkiye", "turkiye"],
  ["holland", "netherlands"],
  ["netherlands", "netherlands"],
  ["usa", "united states"],
  ["us", "united states"],
  ["united states of america", "united states"],
  ["united states", "united states"],
  ["ivory coast", "cote d ivoire"],
  ["cote d ivoire", "cote d ivoire"],
  ["côte d ivoire", "cote d ivoire"],
  ["curacao", "curacao"],
  ["curaçao", "curacao"],
]);

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const schedule = JSON.parse(await readFile(SCHEDULE_FILE, "utf8"));
  const existingResults = JSON.parse(await readFile(RESULTS_FILE, "utf8"));
  const completedEvents = await fetchCompletedEvents(datesToCheck(schedule));
  const discovered = [];

  for (const event of completedEvents) {
    const matched = matchScheduleEvent(schedule, event);
    if (!matched) continue;
    discovered.push({
      id: matched.id,
      date: matched.date,
      stage: matched.stage,
      group: matched.group,
      home: matched.home,
      away: matched.away,
      homeGoals: event.homeGoals,
      awayGoals: event.awayGoals,
    });
  }

  const merged = mergeResults(existingResults, discovered, schedule);
  const before = JSON.stringify(existingResults, null, 2);
  const after = JSON.stringify(merged, null, 2);

  if (before !== after) {
    await writeFile(RESULTS_FILE, `${after}\n`, "utf8");
  }

  const added = merged.filter((result) => !existingResults.some((existing) => existing.id === result.id));
  const changed = merged.filter((result) => {
    const existing = existingResults.find((item) => item.id === result.id);
    return existing && `${existing.homeGoals}-${existing.awayGoals}` !== `${result.homeGoals}-${result.awayGoals}`;
  });

  console.log(
    `Checked ${completedEvents.length} completed ESPN event(s). Matched ${discovered.length}. ` +
      `Results now ${merged.length}; added ${added.length}, changed ${changed.length}.`
  );
  if (added.length || changed.length) {
    [...added, ...changed].forEach((result) => {
      console.log(`${result.id}: ${result.home} ${result.homeGoals}-${result.awayGoals} ${result.away}`);
    });
  }
}

function datesToCheck(schedule) {
  const scheduleDates = schedule
    .filter((match) => match.stage === "group" && !match.homeTbd && !match.awayTbd)
    .map((match) => match.date)
    .sort();
  const start = parseDate(scheduleDates[0]);
  const today = new Date();
  const end = new Date(today);
  end.setUTCDate(end.getUTCDate() + 1);

  if (end < start) return [];

  const dates = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    dates.push(toYmd(cursor));
  }
  return dates;
}

async function fetchCompletedEvents(dates) {
  const events = [];
  for (const date of dates) {
    const response = await fetch(`${ESPN_SCOREBOARD}?dates=${date}`, {
      headers: {
        accept: "application/json",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
      },
    });
    if (!response.ok) {
      console.warn(`ESPN scoreboard ${date} returned ${response.status}`);
      continue;
    }
    const payload = await response.json();
    for (const event of payload.events || []) {
      const parsed = parseEspnEvent(event);
      if (parsed) events.push(parsed);
    }
  }
  return events;
}

function parseEspnEvent(event) {
  const competition = event.competitions?.[0];
  const status = competition?.status?.type || event.status?.type;
  if (!status?.completed) return null;

  const competitors = competition?.competitors || [];
  const home = competitors.find((competitor) => competitor.homeAway === "home");
  const away = competitors.find((competitor) => competitor.homeAway === "away");
  if (!home || !away) return null;

  const homeGoals = Number(home.score);
  const awayGoals = Number(away.score);
  if (!Number.isInteger(homeGoals) || !Number.isInteger(awayGoals)) return null;

  return {
    sourceId: event.id,
    date: competition.date || event.date,
    home: home.team?.displayName || home.team?.name,
    away: away.team?.displayName || away.team?.name,
    homeGoals,
    awayGoals,
  };
}

function matchScheduleEvent(schedule, event) {
  const eventHome = normalizeTeam(event.home);
  const eventAway = normalizeTeam(event.away);
  return schedule.find((match) => {
    if (match.homeTbd || match.awayTbd) return false;
    const scheduleHome = normalizeTeam(match.home);
    const scheduleAway = normalizeTeam(match.away);
    return scheduleHome === eventHome && scheduleAway === eventAway;
  });
}

function mergeResults(existingResults, discovered, schedule) {
  const byId = new Map(existingResults.map((result) => [result.id, result]));
  for (const result of discovered) {
    byId.set(result.id, result);
  }

  const scheduleOrder = new Map(schedule.map((match, index) => [match.id, index]));
  return [...byId.values()].sort((a, b) => {
    const left = scheduleOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const right = scheduleOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return left - right;
  });
}

function normalizeTeam(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return TEAM_ALIASES.get(normalized) || normalized;
}

function parseDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function toYmd(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}
