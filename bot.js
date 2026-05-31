const puppeteer = require('puppeteer');
const { google } = require('googleapis');
const schedule = require('node-schedule');

// ── Google Sheets Auth (credentials from env var) ────────────────
const SHEET_ID = process.env.SHEET_ID;

async function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// ── Read Users from Sheet ────────────────────────────────────────
async function getUsers(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Users!A3:I50',
  });
  const rows = res.data.values || [];
  return rows
    .filter(r => r[5] && r[5].toLowerCase() === 'yes')
    .map(r => ({
      index: r[0],
      name: r[1],
      username: r[2],
      password: r[3],
      time: r[4],
      active: r[5],
    }));
}

// ── Log Result to Sheet ──────────────────────────────────────────
async function logResult(sheets, data) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'Earnings Log!A:K',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        '',
        data.name,
        data.username,
        data.date,
        data.time,
        data.deployStatus,
        data.rentStatus,
        data.totalEarnings,
        data.dailyRent,
        data.anomaly,
        data.notes,
      ]],
    },
  });

  if (data.anomaly === 'Yes') {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Anomaly Report!A:K',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          '',
          data.name,
          data.username,
          data.date,
          data.time,
          data.deployStatus,
          data.rentStatus,
          data.totalEarnings,
          data.dailyRent,
          data.anomaly,
          data.notes,
        ]],
      },
    });
  }

  const usersRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Users!C3:C50',
  });
  const userRows = usersRes.data.values || [];
  const rowIndex = userRows.findIndex(r => r[0] === data.username);
  if (rowIndex !== -1) {
    const sheetRow = rowIndex + 3;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Users!G${sheetRow}:I${sheetRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[`${data.date} ${data.time}`, data.totalEarnings, data.dailyRent]],
      },
    });
  }
}

// ── Click Button with Retry ──────────────────────────────────────
async function clickButtonWithRetry(page, buttonText, maxAttempts = 5, delayMs = 120000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`  [${buttonText}] Attempt ${attempt}/${maxAttempts}`);
    try {
      const found = await page.evaluate((text) => {
        const elements = Array.from(document.querySelectorAll('button, a, span, div'));
        const match = elements.find(el => el.innerText && el.innerText.trim() === text);
        if (match) { match.click(); return true; }
        return false;
      }, buttonText);

      if (found) {
        console.log(`  [${buttonText}] Clicked on attempt ${attempt}`);
        await new Promise(r => setTimeout(r, 3000));
        return { success: true, attempts: attempt };
      }
    } catch (err) {
      console.log(`  [${buttonText}] Error: ${err.message}`);
    }
    if (attempt < maxAttempts) {
      console.log(`  [${buttonText}] Waiting 2 min before retry...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return { success: false, attempts: maxAttempts };
}

// ── Scrape Earnings with Retry ───────────────────────────────────
async function scrapeEarningsWithRetry(page, maxAttempts = 5, delayMs = 120000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`  [Earnings] Attempt ${attempt}/${maxAttempts}`);
    try {
      const earnings = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('*'));
        let totalEarnings = null;
        let dailyRent = null;
        for (const el of cards) {
          const text = el.innerText || '';
          if (text.includes('Total Earnings')) {
            const next = el.nextElementSibling || el.querySelector('*');
            if (next) totalEarnings = next.innerText.trim();
          }
          if (text.includes('Daily GPUaaS Rent')) {
            const next = el.nextElementSibling || el.querySelector('*');
            if (next) dailyRent = next.innerText.trim();
          }
        }
        return { totalEarnings, dailyRent };
      });

      if (earnings.totalEarnings || earnings.dailyRent) {
        return { success: true, ...earnings };
      }
    } catch (err) {
      console.log(`  [Earnings] Error: ${err.message}`);
    }
    if (attempt < maxAttempts) await new Promise(r => setTimeout(r, delayMs));
  }
  return { success: false, totalEarnings: '-', dailyRent: '-' };
}

// ── Run Bot for One User ─────────────────────────────────────────
async function runForUser(user) {
  console.log(`\n===== ${user.name} (${user.username}) =====`);
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const time = now.toTimeString().slice(0, 5);

  const result = {
    name: user.name,
    username: user.username,
    date, time,
    deployStatus: 'Not Required',
    rentStatus: 'Not Required',
    totalEarnings: '-',
    dailyRent: '-',
    anomaly: 'No',
    notes: '',
  };

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    console.log(`  Logging in...`);
    await page.goto('https://hyperbolicglobal.com/admin', { waitUntil: 'networkidle2', timeout: 30000 });

    await page.evaluate((username, password) => {
      const inputs = Array.from(document.querySelectorAll('input'));
      const userField = inputs.find(i => i.type === 'text' || i.name?.toLowerCase().includes('user') || i.placeholder?.toLowerCase().includes('user') || i.placeholder?.toLowerCase().includes('id'));
      const passField = inputs.find(i => i.type === 'password');
      if (userField) userField.value = username;
      if (passField) passField.value = password;
    }, user.username, user.password);

    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
      const loginBtn = btns.find(b => /login|sign in|submit/i.test(b.innerText || b.value || ''));
      if (loginBtn) loginBtn.click();
    });

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));
    console.log(`  Logged in`);

    const deployResult = await clickButtonWithRetry(page, 'Deploy');
    result.deployStatus = deployResult.success
      ? `✅ Success (attempt ${deployResult.attempts})`
      : '❌ Deploy Failed';
    if (!deployResult.success) { result.anomaly = 'Yes'; result.notes += 'Deploy failed. '; }

    const rentResult = await clickButtonWithRetry(page, 'Get Rent');
    result.rentStatus = rentResult.success
      ? `✅ Success (attempt ${rentResult.attempts})`
      : '❌ Rent Failed';
    if (!rentResult.success) { result.anomaly = 'Yes'; result.notes += 'Get Rent failed. '; }

    const earningsResult = await scrapeEarningsWithRetry(page);
    if (earningsResult.success) {
      result.totalEarnings = earningsResult.totalEarnings;
      result.dailyRent = earningsResult.dailyRent;
    } else {
      result.anomaly = 'Yes';
      result.notes += 'Earnings scrape failed.';
    }

  } catch (err) {
    console.error(`  Fatal: ${err.message}`);
    result.anomaly = 'Yes';
    result.notes += `Fatal: ${err.message}`;
  } finally {
    await browser.close();
  }

  console.log(`  Done: Deploy=${result.deployStatus}, Rent=${result.rentStatus}, Earnings=${result.totalEarnings}`);
  return result;
}

// ── Schedule All Users ───────────────────────────────────────────
async function scheduleUsers() {
  const sheets = await getSheetsClient();
  const users = await getUsers(sheets);
  console.log(`Loaded ${users.length} active users`);

  const timeGroups = {};
  for (const user of users) {
    if (!user.time) continue;
    if (!timeGroups[user.time]) timeGroups[user.time] = [];
    timeGroups[user.time].push(user);
  }

  for (const [time, groupUsers] of Object.entries(timeGroups)) {
    const [hour, minute] = time.split(':').map(Number);
    groupUsers.forEach((user, index) => {
      const staggerSeconds = index * 60;
      const staggeredMinute = minute + Math.floor(staggerSeconds / 60);
      const staggeredSecond = staggerSeconds % 60;

      // Convert IST to UTC
      let utcHour = hour;
      let utcMinute = staggeredMinute - 30;
      if (utcMinute < 0) { utcMinute += 60; utcHour -= 1; }
      utcHour -= 5;
      if (utcHour < 0) utcHour += 24;

      const cronExp = `${staggeredSecond} ${utcMinute} ${utcHour} * * *`;
      console.log(`Scheduled ${user.name} at IST ${time} → cron: ${cronExp}`);

      schedule.scheduleJob(cronExp, async () => {
        const freshSheets = await getSheetsClient();
        const freshUsers = await getUsers(freshSheets);
        const freshUser = freshUsers.find(u => u.username === user.username);
        if (!freshUser) { console.log(`${user.username} no longer active — skipping`); return; }
        const result = await runForUser(freshUser);
        await logResult(freshSheets, result);
      });
    });
  }

  console.log('All users scheduled. Bot running...');
}

// ── Entry Point ──────────────────────────────────────────────────
scheduleUsers().catch(console.error);

// Refresh schedule daily at midnight IST (18:30 UTC)
schedule.scheduleJob('0 30 18 * * *', async () => {
  console.log('Midnight IST — refreshing schedule...');
  Object.values(schedule.scheduledJobs).forEach(job => job.cancel());
  await scheduleUsers();
});
