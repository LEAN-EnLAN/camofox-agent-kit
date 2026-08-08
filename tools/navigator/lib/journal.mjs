// Run journal: an append-only record of everything the navigator did.
//
// This is the "sistema de registro" half of error prevention. Without it, a run
// that goes wrong leaves you with a final error message and no idea which of
// twenty steps caused it. With it, every step carries what was seen, what was
// decided, why, and a frame you can look at.
//
// Two rules the format exists to enforce:
//
//   1. SECRETS NEVER LAND HERE. The moment signing in is permitted at all, the
//      navigator handles credentials, and a journal is exactly the file someone
//      pastes into a bug report. Redaction happens on the way in, so no future
//      caller can forget to do it.
//   2. Append-only, one JSON object per line. A crashed run still leaves a
//      readable journal, which is the whole point of having one.

import { mkdirSync, appendFileSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { redactValue, isSecretField } from "./policy.mjs";

const STATE_ROOT = join(
  process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
  "camofox-navigator",
  "runs",
);

export class Journal {
  constructor(runId, { task = "" } = {}) {
    this.runId = runId;
    this.dir = join(STATE_ROOT, runId);
    this.framesDir = join(this.dir, "frames");
    this.path = join(this.dir, "journal.jsonl");
    this.step = 0;
    this.startedAt = new Date().toISOString();
    mkdirSync(this.framesDir, { recursive: true });
    writeFileSync(
      join(this.dir, "meta.json"),
      JSON.stringify({ runId, task, startedAt: this.startedAt, camofox: process.env.CAMOFOX_BASE_URL || "http://127.0.0.1:9377" }, null, 2),
    );
    this.append("run_started", { task });
  }

  static create({ task } = {}) {
    // Timestamp-prefixed so `ls` sorts chronologically, which is how anyone
    // actually looks for "the run that just failed".
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    return new Journal(id, { task });
  }

  append(kind, data = {}) {
    this.step += 1;
    const entry = { step: this.step, t: new Date().toISOString(), kind, ...data };
    // Never let a logging failure take down a run that is otherwise working.
    try {
      appendFileSync(this.path, JSON.stringify(entry) + "\n");
    } catch { /* the run matters more than its diary */ }
    return entry;
  }

  /**
   * Record an action. `value` is redacted when the target looks secret-bearing,
   * so a typed password becomes «redacted N chars» here and in any tool result
   * derived from the journal.
   */
  action({ action, index, value, element, result, obstacle }) {
    const secret = isSecretField(element) || isSecretField({ label: element?.label, type: element?.type });
    return this.append("action", {
      action,
      index,
      value: value === undefined ? undefined : redactValue(value, { isSecret: secret }),
      valueRedacted: secret || undefined,
      element: element ? { tag: element.tag, type: element.type, label: element.label } : undefined,
      result,
      obstacle: obstacle ? { class: obstacle.class, verdict: obstacle.verdict } : undefined,
    });
  }

  observation({ url, title, elementCount, obstacle, fingerprint }) {
    return this.append("observation", {
      url, title, elementCount, fingerprint,
      obstacle: obstacle ? { class: obstacle.class, verdict: obstacle.verdict, why: obstacle.why } : undefined,
    });
  }

  /** Save a frame and reference it from the journal. */
  frame(pngBuffer, { label = "", annotated = false } = {}) {
    const name = `${String(this.step + 1).padStart(3, "0")}${annotated ? "-annotated" : ""}.png`;
    const path = join(this.framesDir, name);
    writeFileSync(path, pngBuffer);
    this.append("frame", { file: `frames/${name}`, bytes: pngBuffer.length, label, annotated });
    return path;
  }

  finish({ outcome, summary = "" }) {
    this.append("run_finished", { outcome, summary });
    const meta = JSON.parse(readFileSync(join(this.dir, "meta.json"), "utf8"));
    writeFileSync(
      join(this.dir, "meta.json"),
      JSON.stringify({ ...meta, finishedAt: new Date().toISOString(), outcome, summary, steps: this.step }, null, 2),
    );
    return this.dir;
  }

  read() {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8").split("\n").filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return { kind: "unparseable", raw: l.slice(0, 200) }; }
    });
  }
}

export function loadJournal(runId) {
  const dir = join(STATE_ROOT, runId);
  if (!existsSync(dir)) throw new Error(`no such run: ${runId}`);
  const j = Object.create(Journal.prototype);
  j.runId = runId;
  j.dir = dir;
  j.framesDir = join(dir, "frames");
  j.path = join(dir, "journal.jsonl");
  return j;
}

export function listRuns(limit = 20) {
  if (!existsSync(STATE_ROOT)) return [];
  return readdirSync(STATE_ROOT).sort().reverse().slice(0, limit).map((id) => {
    try {
      return { id, ...JSON.parse(readFileSync(join(STATE_ROOT, id, "meta.json"), "utf8")) };
    } catch {
      return { id, broken: true };
    }
  });
}

export const RUNS_ROOT = STATE_ROOT;
