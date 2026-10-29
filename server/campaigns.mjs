import fs from 'node:fs';
import path from 'node:path';

/**
 * A campaign is a scored unit of work: a start time, a baseline of what was
 * already known, and the cost of everything that happened since.
 *
 * Turns are cheap to measure individually and meaningless individually. The
 * number that matters is per finding: tokens, wall time and money to reach a
 * confirmed result — and whether that result held up.
 */

const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

export class Campaigns {
  constructor(dataDir, store) {
    this.path = path.join(dataDir, 'campaigns.json');
    this.store = store;
    this.list = [];
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      this.list = raw.campaigns || [];
    } catch {
      this.list = [];
    }
  }

  flush() {
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ campaigns: this.list.slice(0, 100) }, null, 2));
      fs.renameSync(tmp, this.path);
    } catch { /* never take a turn down for bookkeeping */ }
  }

  active() {
    return this.list.find((c) => !c.endedAt) || null;
  }

  start({ name, challenge = '' } = {}) {
    if (this.active()) throw new Error('a campaign is already running — stop it first');
    const now = Date.now();
    const campaign = {
      id: `cmp_${hex(8)}`,
      name: String(name || 'campaign').slice(0, 80),
      challenge: String(challenge || ''),
      startedAt: now,
      endedAt: null,
      tokens: { prompt: 0, completion: 0 },
      cost: 0,
      turns: 0,
      ms: 0,
      byAgent: {},
      baseline: this.store.listFindings().map((f) => f.id),
    };
    this.list.unshift(campaign);
    this.flush();
    return campaign;
  }

  stop() {
    const campaign = this.active();
    if (!campaign) return null;
    campaign.endedAt = Date.now();
    this.flush();
    return campaign;
  }

  /** Called for every completed agent turn, wherever it came from. */
  record({ usage, cost = 0, ms = 0, agent = 'unknown' } = {}) {
    const campaign = this.active();
    if (!campaign) return null;
    const prompt = Number(usage?.prompt || 0);
    const completion = Number(usage?.completion || 0);
    campaign.tokens.prompt += prompt;
    campaign.tokens.completion += completion;
    campaign.cost += Number(cost || 0);
    campaign.ms += Number(ms || 0);
    campaign.turns += 1;
    const key = agent || 'unknown';
    campaign.byAgent[key] = (campaign.byAgent[key] || 0) + 1;
    this.flush();
    return campaign;
  }

  /** Findings created since the baseline, with the campaign's own timing. */
  summary(campaign) {
    const baseline = new Set(campaign.baseline || []);
    const fresh = this.store.listFindings().filter((f) => f.campaignId === campaign.id || !baseline.has(f.id));
    const buckets = { candidate: 0, reproduced: 0, confirmed: 0, dismissed: 0 };
    for (const f of fresh) buckets[f.status] = (buckets[f.status] || 0) + 1;

    const confirmed = fresh.filter((f) => f.status === 'confirmed');
    const firstConfirmedAt = confirmed.length
      ? Math.min(...confirmed.map((f) => f.verifiedAt || f.updatedAt || f.ts || campaign.startedAt))
      : null;

    const totalTokens = campaign.tokens.prompt + campaign.tokens.completion;
    const elapsedMs = (campaign.endedAt || Date.now()) - campaign.startedAt;
    const proven = buckets.confirmed || 0;

    return {
      id: campaign.id,
      name: campaign.name,
      challenge: campaign.challenge,
      running: !campaign.endedAt,
      startedAt: campaign.startedAt,
      endedAt: campaign.endedAt,
      elapsedMs,
      turns: campaign.turns,
      tokens: { ...campaign.tokens, total: totalTokens },
      cost: Number(campaign.cost.toFixed(4)),
      findings: { total: fresh.length, ...buckets },
      timeToFirstConfirmedMs: firstConfirmedAt ? firstConfirmedAt - campaign.startedAt : null,
      tokensPerConfirmed: proven ? Math.round(totalTokens / proven) : null,
      costPerConfirmed: proven ? Number((campaign.cost / proven).toFixed(4)) : null,
      byAgent: campaign.byAgent,
      baseline: campaign.baseline || [],
    };
  }

  summaries() {
    return this.list.map((c) => this.summary(c));
  }
}
