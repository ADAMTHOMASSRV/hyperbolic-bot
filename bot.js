const puppeteer = require('puppeteer');
const { google } = require('googleapis');
const schedule = require('node-schedule');

const SHEET_ID = process.env.SHEET_ID;
const LOGIN_URL = 'https://hyperbolicglobal.com/login';

// ── Google Sheets Auth ───────────────────────────────────────────
async function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// ── Read Users ───────────────────────────────────────────────────
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

// ── Log Result ───────────────────────────────────────────────────
async function logResult(sheets, data) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'Earnings Log!A:K',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        '', data.name, data.username, data.date, data.time,
        data.deployStatus, data.rentStatus,
        data.totalEarnings, data.dailyRent,
        data.anomaly, data.notes,
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
          '', data.name, data.username, data.date, data.time,
          data.deployStatus, data.rentStatus,
          data.totalEarnings, data.dailyRent,
          data.anomaly, data.notes,
        ]],
      },
    });
  }

  // Update Users tab Last Run, Last Total, Last Daily Rent
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

// ── Scrape a value by label ──────────────────────────────────────
async function scrapeByLabel(page, label) {
  return await page.evaluate((lbl) => {
    const all = Array.from(document.querySelectorAll('*'));
    for (const el of all) {
      const txt = el.innerText?.trim();
      if (txt === lbl) {
        // Look at siblings and parent children for the value
        const parent = el.parentElement;
        if (parent) {
          const children = Array.from(parent.children);
          for (const child of children) {
            const val = child.innerText?.trim();
            if (val && val !== lbl && val.match(/[0-9]/)) return val;
          }
          // Try parent's parent
          const grandParent = parent.parentElement;
          if (grandParent) {
            const vals = grandParent.innerText.split('\n').map(s => s.trim()).filter(s => s.match(/[¥$₹0-9]/));
            if (vals.length) return vals[0];
          }
        }
      }
    }
    return null;
  }, label);
}

// ── Click button by partial text ─────────────────────────────────
async function clickButton(page, texts) {
  return await page.evaluate((textList) => {
    const els = Array.from(document.querySelectorAll('button, a, div, span'));
    for (const text of textList) {
      const match = els.find(el => el.innerText?.trim().toLowerCase().includes(text.toLowerCase()));
      if (match) {
        match.click();
        return { found: true, text };
      }
    }
    return { found: false };
  }, texts);
}

// ── Run Bot for One User ─────────────────────────────────────────
async function runForUser(user) {
  console.log(`\n===== ${user.name} (${user.username}) =====`);
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const time = now.toTimeString().slice(0, 5);

  const result = {
    name: user.name, username: user.username,
    date, time,
    deployStatus: 'N/A',
    rentStatus: 'N/A',
    totalEarnings: '-', dailyRent: '-',
    anomaly: 'No', notes: '',
  };

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // ── Login ──────────────────────────────────────────────────
    console.log(`  Logging in to ${LOGIN_URL}...`);
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    // Fill ID NO. field
    await page.evaluate((username, password) => {
      const inputs = Array.from(document.querySelectorAll('input'));
      const idField = inputs.find(i =>
        i.placeholder?.toLowerCase().includes('id') ||
        i.name?.toLowerCase().includes('id') ||
        i.type === 'text'
      );
      const passField = inputs.find(i => i.type === 'password');
      if (idField) { idField.focus(); idField.value = username; idField.dispatchEvent(new Event('input', {bubbles:true})); }
      if (passField) { passField.focus(); passField.value = password; passField.dispatchEvent(new Event('input', {bubbles:true})); }
    }, user.username, user.password);

    await new Promise(r => setTimeout(r, 1000));

    // Click Log In button
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
      const loginBtn = btns.find(b => /log\s*in|sign\s*in|submit/i.test(b.innerText || b.value || ''));
      if (loginBtn) loginBtn.click();
    });

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));

    const url = page.url();
    console.log(`  After login URL: ${url}`);

    if (url.includes('login')) {
      throw new Error('Login failed — still on login page');
    }
    console.log(`  Logged in successfully`);

    // ── Try clicking rent-related buttons ─────────────────────
    // Look for any button that might collect rent
    const rentClicked = await clickButton(page, [
      'Get Rent', 'Collect Rent', 'Claim Rent', 'Claim', 'Collect',
      'Get Daily Rent', 'Receive Rent', 'Deploy', 'Start', 'Run'
    ]);
    
    if (rentClicked.found) {
      console.log(`  Clicked: ${rentClicked.text}`);
      result.rentStatus = `✅ Clicked ${rentClicked.text}`;
      await new Promise(r => setTimeout(r, 3000));
    } else {
      console.log(`  No rent button found — scraping values only`);
      result.rentStatus = 'No button found';
      result.deployStatus = 'No button found';
    }

    // ── Scrape all visible values ──────────────────────────────
    await new Promise(r => setTimeout(r, 2000));

    const labels = [
      'Total Earnings', 'Daily GPUaaS Rent', 'Total Daily Rent',
      'Income Wallet', 'GPUaaS', 'Account Balance'
    ];

    const scraped = {};
    for (const label of labels) {
      const val = await scrapeByLabel(page, label);
      if (val) {
        scraped[label] = val;
        console.log(`  ${label}: ${val}`);
      }
    }

    // Also grab ALL text with ¥ symbol as fallback
    const allValues = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('*'));
      const found = [];
      for (const el of all) {
        if (el.children.length === 0) {
          const txt = el.innerText?.trim();
          if (txt && txt.includes('¥')) found.push(txt);
        }
      }
      return [...new Set(found)];
    });
    console.log(`  All ¥ values on page: ${allValues.join(' | ')}`);

    result.totalEarnings = scraped['Total Earnings'] || scraped['Income Wallet'] || allValues[0] || '-';
    result.dailyRent = scraped['Daily GPUaaS Rent'] || scraped['Total Daily Rent'] || allValues[1] || '-';
    result.deployStatus = result.deployStatus === 'N/A' ? '✅ Logged in' : result.deployStatus;

    if (result.totalEarnings === '-' && result.dailyRent === '-') {
      result.anomaly = 'Yes';
      result.notes = 'Could not scrape values';
    }

  } catch (err) {
    console.error(`  Error: ${err.message}`);
    result.anomaly = 'Yes';
    result.notes = err.message;
    result.deployStatus = '❌ Error';
    result.rentStatus = '❌ Error';
  } finally {
    await browser.close();
  }

  console.log(`  Result: Total=${result.totalEarnings} Daily=${result.dailyRent}`);
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
    const timeStr = typeof user.time === 'string' ? user.time :
      new Date(user.time).toTimeString().slice(0, 5);
    if (!timeGroups[timeStr]) timeGroups[timeStr] = [];
    timeGroups[timeStr].push(user);
  }

  for (const [time, groupUsers] of Object.entries(timeGroups)) {
    const [hour, minute] = time.split(':').map(Number);
    groupUsers.forEach((user, index) => {
      const staggerSeconds = index * 60;
      let utcMinute = minute + Math.floor(staggerSeconds / 60) - 30;
      let utcHour = hour - 5;
      if (utcMinute < 0) { utcMinute += 60; utcHour -= 1; }
      if (utcMinute >= 60) { utcMinute -= 60; utcHour += 1; }
      if (utcHour < 0) utcHour += 24;
      if (utcHour >= 24) utcHour -= 24;

      const cronExp = `${staggerSeconds % 60} ${utcMinute} ${utcHour} * * *`;
      console.log(`Scheduled ${user.name} at IST ${time} → cron: ${cronExp}`);

      schedule.scheduleJob(cronExp, async () => {
        const freshSheets = await getSheetsClient();
        const freshUsers = await getUsers(freshSheets);
        const freshUser = freshUsers.find(u => u.username === user.username);
        if (!freshUser) { console.log(`${user.username} inactive — skipping`); return; }
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
  const jobs = schedule.scheduledJobs;
  Object.keys(jobs).forEach(k => jobs[k].cancel());
  await scheduleUsers();
});
