#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEDULE_FILE = resolve(ROOT, "data/schedule.json");
const RESULTS_FILE = resolve(ROOT, "data/results.json");
const ESPN_SCOREBOARD =
  "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
// Knockout kickoffs are at least 210 minutes apart, so a 90-minute window
// around the scheduled kickoff can only ever contain one fixture.
const KICKOFF_TOLERANCE_MS = 90 * 60 * 1000;

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
  ["cabo verde", "cabo verde"],
  ["cape verde", "cabo verde"],
  ["cape verde islands", "cabo verde"],
  ["cabo verde islands", "cabo verde"],
  ["congo dr", "congo dr"],
  ["dr congo", "congo dr"],
  ["d r congo", "congo dr"],
  ["drc", "congo dr"],
  ["democratic republic of congo", "congo dr"],
  ["democratic republic congo", "congo dr"],
  ["congo democratic republic", "congo dr"],
  ["congo kinshasa", "congo dr"],
]);

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const schedule = JSON.parse(await readFile(SCHEDULE_FILE, "utf8"));
  const existingResults = JSON.parse(await readFile(RESULTS_FILE, "utf8"));
  const canonicalNames = buildCanonicalNames(schedule);
  const events = await fetchEvents(datesToCheck(schedule));
  const discovered = [];
  let scheduleChanged = false;

  for (const event of events) {
    let matched = matchScheduleByNames(schedule, event);
    let swapped = matched?.swapped ?? false;
    let fixture = matched?.fixture ?? null;

    if (!fixture) {
      fixture = matchScheduleByKickoff(schedule, event);
      if (!fixture) continue;

      const homeName = canonicalNames.get(normalizeTeam(event.home));
      const awayName = canonicalNames.get(normalizeTeam(event.away));
      if (!homeName || !awayName) {
        console.warn(
          `Skipping match ${fixture.id}: unrecognised team(s) "${event.home}" / "${event.away}"`
        );
        continue;
      }

      if (fixture.homeTbd || fixture.awayTbd) {
        fixture.home = homeName;
        fixture.away = awayName;
        fixture.homeTbd = false;
        fixture.awayTbd = false;
        scheduleChanged = true;
        console.log(`Match ${fixture.id} (${fixture.stage}): teams set to ${homeName} v ${awayName}`);
      } else if (fixture.home === awayName && fixture.away === homeName) {
        swapped = true;
      } else if (fixture.home !== homeName || fixture.away !== awayName) {
        console.warn(
          `Skipping match ${fixture.id}: kickoff matches but teams disagree ` +
            `(schedule ${fixture.home} v ${fixture.away}, ESPN ${event.home} v ${event.away})`
        );
        continue;
      }
    }

    if (!event.completed) continue;

    const result = {
      id: fixture.id,
      date: fixture.date,
      stage: fixture.stage,
      group: fixture.group,
      home: fixture.home,
      away: fixture.away,
      homeGoals: swapped ? event.awayGoals : event.homeGoals,
      awayGoals: swapped ? event.homeGoals : event.awayGoals,
    };
    const homePens = swapped ? event.awayPens : event.homePens;
    const awayPens = swapped ? event.homePens : event.awayPens;
    if (homePens != null && awayPens != null) {
      result.homePens = homePens;
      result.awayPens = awayPens;
    }
    discovered.push(result);
  }

  const merged = mergeResults(existingResults, discovered, schedule);
  const before = JSON.stringify(existingResults, null, 2);
  const after = JSON.stringify(merged, null, 2);

  if (before !== after) {
    await writeFile(RESULTS_FILE, `${after}\n`, "utf8");
  }
  if (scheduleChanged) {
    await writeFile(SCHEDULE_FILE, `${JSON.stringify(schedule, null, 2)}\n`, "utf8");
  }

  const added = merged.filter((result) => !existingResults.some((existing) => existing.id === result.id));
  const changed = merged.filter((result) => {
    const existing = existingResults.find((item) => item.id === result.id);
    return existing && `${existing.homeGoals}-${existing.awayGoals}` !== `${result.homeGoals}-${result.awayGoals}`;
  });

  console.log(
    `Checked ${events.length} ESPN event(s). Matched ${discovered.length} completed. ` +
      `Results now ${merged.length}; added ${added.length}, changed ${changed.length}. ` +
      `Schedule ${scheduleChanged ? "updated" : "unchanged"}.`
  );
  if (added.length || changed.length) {
    [...added, ...changed].forEach((result) => {
      const pens = result.homePens != null ? ` (${result.homePens}-${result.awayPens} pens)` : "";
      console.log(`${result.id}: ${result.home} ${result.homeGoals}-${result.awayGoals} ${result.away}${pens}`);
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
  // Look two days ahead so upcoming knockout matchups are filled into the
  // schedule as soon as ESPN publishes the teams.
  end.setUTCDate(end.getUTCDate() + 2);

  if (end < start) return [];

  const dates = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    dates.push(toYmd(cursor));
  }
  return dates;
}

async function fetchEvents(dates) {
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
  const competitors = competition?.competitors || [];
  const home = competitors.find((competitor) => competitor.homeAway === "home");
  const away = competitors.find((competitor) => competitor.homeAway === "away");
  if (!home || !away) return null;

  const homeName = home.team?.displayName || home.team?.name;
  const awayName = away.team?.displayName || away.team?.name;
  if (!isRealTeamName(homeName) || !isRealTeamName(awayName)) return null;

  const completed = Boolean(status?.completed);
  const homeGoals = Number(home.score);
  const awayGoals = Number(away.score);
  if (completed && (!Number.isInteger(homeGoals) || !Number.isInteger(awayGoals))) return null;

  const homePens = home.shootoutScore != null ? Number(home.shootoutScore) : null;
  const awayPens = away.shootoutScore != null ? Number(away.shootoutScore) : null;

  return {
    sourceId: event.id,
    date: competition.date || event.date,
    home: homeName,
    away: awayName,
    completed,
    homeGoals,
    awayGoals,
    homePens: Number.isInteger(homePens) ? homePens : null,
    awayPens: Number.isInteger(awayPens) ? awayPens : null,
  };
}

function isRealTeamName(name) {
  if (!name) return false;
  return !/^(tbd|to be|winner|loser|runner)/i.test(name.trim());
}

function buildCanonicalNames(schedule) {
  const names = new Map();
  for (const match of schedule) {
    if (match.stage !== "group") continue;
    names.set(normalizeTeam(match.home), match.home);
    names.set(normalizeTeam(match.away), match.away);
  }
  return names;
}

function matchScheduleByNames(schedule, event) {
  const eventHome = normalizeTeam(event.home);
  const eventAway = normalizeTeam(event.away);
  for (const match of schedule) {
    if (match.homeTbd || match.awayTbd) continue;
    const scheduleHome = normalizeTeam(match.home);
    const scheduleAway = normalizeTeam(match.away);
    if (scheduleHome === eventHome && scheduleAway === eventAway) {
      return { fixture: match, swapped: false };
    }
    if (scheduleHome === eventAway && scheduleAway === eventHome && match.stage !== "group") {
      return { fixture: match, swapped: true };
    }
  }
  return null;
}

function matchScheduleByKickoff(schedule, event) {
  const eventTime = Date.parse(event.date);
  if (!Number.isFinite(eventTime)) return null;

  let best = null;
  let bestDiff = Infinity;
  for (const match of schedule) {
    if (match.stage === "group") continue;
    const kickoff = kickoffUtc(match);
    if (kickoff == null) continue;
    const diff = Math.abs(kickoff - eventTime);
    if (diff < bestDiff) {
      best = match;
      bestDiff = diff;
    }
  }
  return bestDiff <= KICKOFF_TOLERANCE_MS ? best : null;
}

function kickoffUtc(match) {
  const parts = String(match.time || "").match(/^(\d{1,2}):(\d{2})\s*UTC([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!parts) return null;
  const [, hours, minutes, sign, offsetHours, offsetMinutes] = parts;
  const offset = (Number(offsetHours) * 60 + Number(offsetMinutes || 0)) * (sign === "-" ? -1 : 1);
  const base = parseDate(match.date).getTime();
  return base + (Number(hours) * 60 + Number(minutes) - offset) * 60 * 1000;
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
