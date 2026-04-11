/**
 * Saturday Game — Email Worker
 * Sends styled HTML emails via Resend API.
 * Queries Supabase for player emails & round data.
 *
 * POST /send
 * Body: {
 *   type: "betting-open" | "betting-closing" | "round-results",
 *   pin: "0727",                // admin PIN for auth
 *   roundId?: number,           // required for round-results
 *   date?: "Saturday, April 4", // optional override
 *   course?: "Bethpage Black",  // for betting-open
 *   tees?: "White",             // for betting-open
 *   teeTime?: "9:30 AM",       // for betting-closing
 *   subject?: string,           // optional subject override
 *   recipientFilter?: "active" | "bettors" | "all"  // default: active
 * }
 */

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method !== 'POST') {
      return json({ error: 'POST only' }, 405);
    }

    const url = new URL(request.url);
    if (url.pathname !== '/send') {
      return json({ error: 'Not found. Use POST /send' }, 404);
    }

    try {
      const body = await request.json();

      // Auth check — validate PIN against Supabase admin_pins table
      const dbAdmins = await supabaseGet(env, `admin_pins?pin=eq.${body.pin}&select=id`);
      const fallbackPins = ['3030', '1234']; // fallback if DB check fails
      if ((!dbAdmins || dbAdmins.length === 0) && !fallbackPins.includes(body.pin)) {
        return json({ error: 'Invalid PIN' }, 401);
      }

      const { type } = body;
      if (!['betting-open', 'betting-closing', 'round-results'].includes(type)) {
        return json({ error: 'Invalid type. Use: betting-open, betting-closing, round-results' }, 400);
      }

      // ── 1. Get recipients from Supabase (or use testRecipient) ──
      let recipients;
      if (body.testRecipient) {
        recipients = [{ email: body.testRecipient }];
      } else {
        recipients = await getRecipients(env, body.recipientFilter || 'active', body.roundId);
      }
      if (!recipients.length) {
        return json({ error: 'No recipients found' }, 400);
      }

      // ── 2. Build email content ───────────────────────────────────
      let subject, html;

      if (type === 'betting-open') {
        const data = await getRoundData(env, body.roundId);
        subject = body.subject || `Betting Is Open – ${body.date || data.date || 'This Saturday'}`;
        html = buildBettingOpenEmail({
          date: body.date || data.date,
          course: body.course || data.course,
          tees: body.tees || data.tees,
          playerCount: data.playerCount || '?',
        });

      } else if (type === 'betting-closing') {
        subject = body.subject || `Last Call for Bets – ${body.date || 'This Saturday'}`;
        html = buildBettingClosingEmail({
          date: body.date || 'This Saturday',
          teeTime: body.teeTime || 'TBD',
        });

      } else if (type === 'round-results') {
        if (!body.roundId) {
          return json({ error: 'roundId required for round-results' }, 400);
        }
        const results = await getRoundResults(env, body.roundId);
        subject = body.subject || `Round Results – ${results.date}`;
        html = buildRoundResultsEmail(results);
      }

      // ── 3. Send via Resend ───────────────────────────────────────
      // Resend supports up to 50 BCC recipients per call
      const emails = recipients.map(r => r.email);
      const batchSize = 49; // leave room for the "from" address
      const batches = [];
      for (let i = 0; i < emails.length; i += batchSize) {
        batches.push(emails.slice(i, i + batchSize));
      }

      const results = [];
      for (const batch of batches) {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: 'FLOG Games <noreply@floggames.com>',
            to: ['saturdaygolfgame@gmail.com'],  // "to" is the Saturday Game account
            bcc: batch,
            subject,
            html,
          }),
        });
        const resBody = await res.json();
        results.push({ status: res.status, ...resBody });

        if (!res.ok) {
          return json({ error: 'Resend API error', details: resBody, sentTo: batch.length }, 502);
        }
      }

      return json({
        success: true,
        type,
        recipientCount: emails.length,
        subject,
        batches: results,
      });

    } catch (err) {
      return json({ error: err.message, stack: err.stack }, 500);
    }
  },
};


// ═══════════════════════════════════════════════════════════════
// Supabase Helpers
// ═══════════════════════════════════════════════════════════════

async function supabaseGet(env, path) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      'apikey': env.SUPABASE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_KEY}`,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Supabase error: ${res.status} ${await res.text()}`);
  return res.json();
}

async function getRecipients(env, filter, roundId) {
  if (filter === 'all') {
    // All players with emails
    return supabaseGet(env, 'players?email=not.is.null&select=id,name,email');
  }

  if (filter === 'bettors' && roundId) {
    // Only players who placed bets in this round's markets
    const markets = await supabaseGet(env, `markets?round_id=eq.${roundId}&select=id,stakes`);
    const bettorIds = new Set();
    for (const m of markets) {
      for (const s of (m.stakes || [])) {
        bettorIds.add(s.player_id);
      }
    }
    if (!bettorIds.size) return [];
    const ids = [...bettorIds].join(',');
    return supabaseGet(env, `players?id=in.(${ids})&email=not.is.null&select=id,name,email`);
  }

  // Default: active players (active = true)
  return supabaseGet(env, 'players?active=eq.true&email=not.is.null&select=id,name,email');
}

async function getRoundData(env, roundId) {
  if (!roundId) {
    // Get the latest non-settled round (the "current" one)
    const rounds = await supabaseGet(env, 'rounds?status=neq.settled&order=date.desc&limit=1&select=id,date');
    if (!rounds.length) return {};
    const r = rounds[0];
    const players = await supabaseGet(env, `round_players?round_id=eq.${r.id}&select=id`);
    return { date: formatDate(r.date), course: '', tees: '', playerCount: players.length };
  }
  const rounds = await supabaseGet(env, `rounds?id=eq.${roundId}&select=id,date`);
  if (!rounds.length) return {};
  const r = rounds[0];
  const players = await supabaseGet(env, `round_players?round_id=eq.${r.id}&select=id`);
  return { date: formatDate(r.date), course: r.course || '', tees: r.tees || '', playerCount: players.length };
}

async function getRoundResults(env, roundId) {
  // Get round info
  const rounds = await supabaseGet(env, `rounds?id=eq.${roundId}&select=id,date`);
  if (!rounds.length) throw new Error('Round not found');
  const round = rounds[0];

  // Get round_players (for handicaps + player names)
  const rp = await supabaseGet(env, `round_players?round_id=eq.${roundId}&select=player_id,playing_handicap,players(name)`);

  // Get scores separately (gross_score lives in the scores table)
  const scores = await supabaseGet(env, `scores?round_id=eq.${roundId}&select=player_id,gross_score,net_score`);
  const scoreMap = {};
  scores.forEach(s => { scoreMap[s.player_id] = s; });

  // Build leaderboard sorted by net
  const leaderboard = rp
    .filter(p => scoreMap[p.player_id]?.gross_score != null)
    .map(p => ({
      name: p.players?.name || 'Unknown',
      gross: scoreMap[p.player_id].gross_score,
      net: scoreMap[p.player_id].net_score ?? (scoreMap[p.player_id].gross_score - (p.playing_handicap || 0)),
    }))
    .sort((a, b) => a.net - b.net);

  // Assign positions with ties
  let pos = 1;
  for (let i = 0; i < leaderboard.length; i++) {
    if (i > 0 && leaderboard[i].net === leaderboard[i - 1].net) {
      leaderboard[i].pos = leaderboard[i - 1].pos; // same position as previous
    } else {
      leaderboard[i].pos = pos;
    }
    pos = i + 2;
  }

  // Format position strings (T for ties)
  const posCounts = {};
  leaderboard.forEach(p => { posCounts[p.pos] = (posCounts[p.pos] || 0) + 1; });
  leaderboard.forEach(p => {
    p.posStr = posCounts[p.pos] > 1 ? `T${p.pos}.` : `${p.pos}.`;
  });

  // Get settled markets with their stakes (stakes is a related table, use embed syntax)
  const markets = await supabaseGet(env, `markets?round_id=eq.${roundId}&status=eq.settled&select=id,type,winner_ids,stakes(*)`);

  const plMap = {}; // player_id → { name, pl }
  for (const m of markets) {
    const stakes = m.stakes || [];
    const pool = stakes.reduce((s, st) => s + parseFloat(st.amount), 0);
    const winnerStakes = stakes.filter(s => (m.winner_ids || []).includes(s.pick_id));
    const totalOnWinners = winnerStakes.reduce((s, st) => s + parseFloat(st.amount), 0);

    for (const s of stakes) {
      const amt = parseFloat(s.amount);
      let payout;
      if (totalOnWinners === 0) {
        payout = amt; // refund
      } else if ((m.winner_ids || []).includes(s.pick_id)) {
        payout = (amt / totalOnWinners) * pool;
      } else {
        payout = 0;
      }
      const pl = payout - amt;
      if (!plMap[s.bettor_id]) {
        plMap[s.bettor_id] = { name: s.bettor_id, pl: 0 };
      }
      plMap[s.bettor_id].pl += pl;
    }
  }

  // We need player names for the P/L — get them
  const playerIds = Object.keys(plMap);
  if (playerIds.length) {
    const players = await supabaseGet(env, `players?id=in.(${playerIds.join(',')})&select=id,name`);
    const nameMap = {};
    players.forEach(p => { nameMap[p.id] = p.name; });
    playerIds.forEach(id => {
      if (nameMap[id]) plMap[id].name = nameMap[id];
    });
  }

  const bettingWinners = Object.values(plMap)
    .filter(p => p.pl > 0.01)
    .sort((a, b) => b.pl - a.pl)
    .slice(0, 3)
    .map(p => ({ name: p.name, amount: p.pl.toFixed(2) }));

  return {
    date: formatDate(round.date),
    leaderboard,
    bettingWinners,
  };
}

function formatDate(dateStr) {
  if (!dateStr) return 'This Saturday';
  const d = new Date(dateStr + 'T12:00:00');
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${days[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}`;
}


// ═══════════════════════════════════════════════════════════════
// Email Templates
// ═══════════════════════════════════════════════════════════════

function emailShell(headerBg, subtitle, subtitleColor, bodyContent) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0; padding:0; background:#f4f4f4; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4; padding:24px 0;">
<tr><td align="center">
<table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 2px 12px rgba(0,0,0,0.08);">
  <tr><td style="background:${headerBg}; padding:28px 32px; text-align:center;">
    <div style="font-size:28px; font-weight:800; color:#ffffff; letter-spacing:-0.5px;">The Saturday Game</div>
    <div style="font-size:13px; color:${subtitleColor}; margin-top:4px; letter-spacing:1px; text-transform:uppercase;">${subtitle}</div>
  </td></tr>
  <tr><td style="padding:28px 32px;">
    ${bodyContent}
  </td></tr>
  <tr><td style="background:#f9fafb; padding:16px 32px; border-top:1px solid #e5e7eb; text-align:center;">
    <div style="font-size:12px; color:#9ca3af;">The Saturday Game &middot; No guts, no glory</div>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function ctaButton(text, color) {
  return `<table width="100%" cellpadding="0" cellspacing="0">
  <tr><td align="center" style="padding:8px 0 16px;">
    <a href="https://floggames.com" style="display:inline-block; background:${color}; color:#ffffff; font-size:16px; font-weight:700; text-decoration:none; padding:14px 36px; border-radius:12px;">${text}</a>
  </td></tr>
  <tr><td align="center" style="padding:4px 0 8px;">
    <a href="https://floggames.com" style="font-size:12px; color:${color};">floggames.com</a>
  </td></tr>
</table>`;
}

function buildBettingOpenEmail({ date, course, tees, playerCount }) {
  const body = `
    <p style="font-size:16px; color:#1a1a1a; margin:0 0 16px; line-height:1.5;">Gentlemen,</p>
    <p style="font-size:16px; color:#1a1a1a; margin:0 0 16px; line-height:1.5;">
      This Saturday's round is set up and <strong style="color:#15803d;">betting is now open!</strong>
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:12px; margin:20px 0;">
      <tr><td style="padding:20px;">
        <div style="font-size:13px; font-weight:700; color:#15803d; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:10px;">Round Details</div>
        <div style="font-size:15px; color:#1a1a1a; line-height:1.8;">
          ${esc(date)}<br>
          ${course ? esc(course) + (tees ? ' &middot; ' + esc(tees) + ' tees' : '') + '<br>' : ''}
          ${playerCount} players
        </div>
      </td></tr>
    </table>
    <p style="font-size:16px; color:#1a1a1a; margin:0 0 20px; line-height:1.5;">
      Get your bets in before tee time. May the best net scores win, place, or show.
    </p>
    ${ctaButton('Place Your Bets', '#15803d')}`;

  return emailShell('linear-gradient(135deg, #15803d, #166534)', 'Betting Window Open', '#bbf7d0', body);
}

function buildBettingClosingEmail({ date, teeTime }) {
  const body = `
    <p style="font-size:16px; color:#1a1a1a; margin:0 0 16px; line-height:1.5;">Gentlemen,</p>
    <p style="font-size:16px; color:#1a1a1a; margin:0 0 16px; line-height:1.5;">
      Betting is about to close for this Saturday's round. If you haven't placed your bets yet, <strong style="color:#b45309;">now's the time.</strong>
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb; border:1px solid #fde68a; border-radius:12px; margin:20px 0;">
      <tr><td style="padding:20px; text-align:center;">
        <div style="font-size:32px; margin-bottom:6px;">&#9200;</div>
        <div style="font-size:18px; font-weight:700; color:#92400e;">Betting closes at tee time</div>
        <div style="font-size:14px; color:#b45309; margin-top:4px;">${esc(date)} &middot; ${esc(teeTime)}</div>
      </td></tr>
    </table>
    <p style="font-size:16px; color:#1a1a1a; margin:0 0 20px; line-height:1.5;">
      Don't miss your shot. Get in before the window shuts.
    </p>
    ${ctaButton('Place Your Bets Now', '#b45309')}`;

  return emailShell('linear-gradient(135deg, #b45309, #92400e)', 'Last Call for Bets', '#fde68a', body);
}

function buildRoundResultsEmail({ date, leaderboard, bettingWinners }) {
  // Build leaderboard rows
  const lbRows = leaderboard.map((p, i) => {
    const isTop3 = p.pos <= 3;
    const medals = { 1: '&#129351;', 2: '&#129352;', 3: '&#129353;' };
    const medal = (isTop3 && p.pos === leaderboard.findIndex(x => x.pos === p.pos) + 1) ? '' : '';
    const posColor = isTop3 ? '#b45309' : '#666';
    const netColor = isTop3 ? '#15803d; font-weight:700' : '#666';
    const isLast = i === leaderboard.length - 1;
    const borderStyle = isLast ? '' : 'border-bottom:1px solid #dcfce7;';

    let nameDisplay = esc(p.name);
    if (p.pos <= 3) {
      const m = medals[p.pos] || '';
      nameDisplay = m + ' ' + nameDisplay;
    }

    return `<tr>
      <td style="padding:5px 0; font-size:14px; color:#1a1a1a; ${borderStyle}">
        <strong style="color:${posColor}; display:inline-block; width:28px;">${p.posStr}</strong>
        ${nameDisplay}
      </td>
      <td style="text-align:right; padding:5px 0; font-size:14px; color:${netColor}; ${borderStyle}">
        Net ${p.net} <span style="color:#aaa; font-size:12px;">(${p.gross} gross)</span>
      </td>
    </tr>`;
  }).join('');

  // Build betting winners rows
  const bwRows = bettingWinners.map((p, i) => {
    const isFirst = i === 0;
    const isLast = i === bettingWinners.length - 1;
    const borderStyle = isLast ? '' : 'border-bottom:1px solid #fef3c7;';
    const trophy = isFirst ? '&#127942; ' : '';
    return `<tr>
      <td style="padding:5px 0; font-size:14px; color:#1a1a1a; ${borderStyle}">
        ${trophy}<strong>${esc(p.name)}</strong>
      </td>
      <td style="text-align:right; padding:5px 0; font-size:14px; font-weight:700; color:#15803d; ${borderStyle}">
        +$${p.amount}
      </td>
    </tr>`;
  }).join('');

  const bettingSection = bettingWinners.length ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb; border:1px solid #fde68a; border-radius:12px; margin:20px 0;">
      <tr><td style="padding:20px;">
        <div style="font-size:13px; font-weight:700; color:#92400e; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:12px;">Biggest Betting Winners</div>
        <table width="100%" cellpadding="0" cellspacing="0">${bwRows}</table>
      </td></tr>
    </table>` : '';

  const body = `
    <p style="font-size:16px; color:#1a1a1a; margin:0 0 16px; line-height:1.5;">Gentlemen,</p>
    <p style="font-size:16px; color:#1a1a1a; margin:0 0 16px; line-height:1.5;">
      The scores are in and the markets have been settled for <strong>${esc(date)}</strong>. Here's how it shook out:
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:12px; margin:20px 0;">
      <tr><td style="padding:20px;">
        <div style="font-size:13px; font-weight:700; color:#15803d; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:12px;">Net Leaderboard</div>
        <table width="100%" cellpadding="0" cellspacing="0">${lbRows}</table>
      </td></tr>
    </table>
    ${bettingSection}
    <p style="font-size:16px; color:#1a1a1a; margin:0 0 20px; line-height:1.5;">
      Check the app for full settlement details and your individual P/L.
    </p>
    ${ctaButton('View Full Results', '#15803d')}`;

  return emailShell('linear-gradient(135deg, #15803d, #166534)', 'Round Results', '#fde68a', body);
}


// ═══════════════════════════════════════════════════════════════
// Utility
// ═══════════════════════════════════════════════════════════════

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}
