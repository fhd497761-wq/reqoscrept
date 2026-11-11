require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const puppeteer = require('puppeteer');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const QUREO_LOGIN = 'https://me-portal.qureo.education/login';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let isRunning = false;

io.on('connection', (socket) => {
    console.log(`✅ Client connected: ${socket.id}`);
    socket.on('disconnect', () => console.log(`❌ Client disconnected: ${socket.id}`));
});

app.post('/api/solve', async (req, res) => {
    const { studentId, studentPassword } = req.body;
    if (!studentId || !studentPassword) return res.status(400).json({ success: false, error: 'رقم الطالب وكلمة المرور مطلوبين' });
    if (isRunning) return res.status(400).json({ success: false, error: 'يوجد مهمة قيد التنفيذ بالفعل' });
    res.json({ success: true, message: 'تم بدء الحل التلقائي بنجاح' });
    isRunning = true;
    try { await runAutoSolve(studentId, studentPassword, io); }
    catch (error) { io.emit('error', { message: `حدث خطأ: ${error.message}`, type: 'error' }); }
    finally { isRunning = false; io.emit('status', { isRunning: false }); }
});

app.get('/api/status', (req, res) => res.json({ isRunning }));

function emit(io, data) {
    io.emit('progress', { ...data, timestamp: Date.now() });
    console.log(`[PROGRESS] ${data.percent}% - ${data.message}`);
}

async function runAutoSolve(studentId, studentPassword, io) {
    let browser;
    try {
        emit(io, { step: 'launch', message: '🚀 جاري تشغيل المتصفح الخفي...', percent: 5 });
        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-web-security'] });
        const page = await browser.newPage();
        await page.setViewport({ width: 1366, height: 768 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');

        emit(io, { step: 'navigate', message: '🌐 جاري فتح منصة Qureo...', percent: 12 });
        await page.goto(QUREO_LOGIN, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForTimeout(2000);

        emit(io, { step: 'credentials', message: '📝 جاري إدخال بيانات الطالب...', percent: 22 });
        await fillField(page, ['input[name="username"]','input[name="id"]','input[name="email"]','input[name="student_id"]','#username','#id','#email','input[type="text"]'], studentId, 'رقم الطالب');
        await page.waitForTimeout(500);
        await fillField(page, ['input[name="password"]','#password','input[type="password"]'], studentPassword, 'كلمة المرور');
        await page.waitForTimeout(500);

        emit(io, { step: 'login', message: '🔐 جاري تسجيل الدخول...', percent: 32 });
        await submitLogin(page);
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(3000);

        const currentUrl = page.url();
        const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
        const loginFailed = currentUrl.includes('login') || bodyText.includes('Invalid') || bodyText.includes('incorrect') || bodyText.includes('خطأ');
        if (loginFailed) throw new Error('فشل تسجيل الدخول - تحقق من البيانات المدخلة');

        emit(io, { step: 'logged', message: '✅ تم تسجيل الدخول بنجاح!', percent: 40 });
        await page.waitForTimeout(2000);

        emit(io, { step: 'assessments', message: '🔍 جاري البحث عن الاختبارات...', percent: 45 });
        await navigateToAssessments(page);

        emit(io, { step: 'finding', message: '📋 جاري جمع الاختبارات المعلقة...', percent: 50 });
        const assessments = await findAssessments(page);

        if (assessments.length === 0) {
            emit(io, { step: 'current-page', message: '📖 لا يوجد اختبارات منفصلة - جاري حل الأسئلة الحالية...', percent: 55 });
            await solveCurrentPageQuestions(page, io, 0, 1);
        } else {
            emit(io, { step: 'assessments-found', message: `📚 تم العثور على ${assessments.length} اختبار`, percent: 52 });
            for (let i = 0; i < assessments.length; i++) {
                const percent = 52 + ((i + 1) / assessments.length) * 43;
                emit(io, { step: 'solving', message: `📝 جاري حل الاختبار ${i + 1}/${assessments.length}: ${assessments[i].title}`, percent: Math.round(percent), current: i + 1, total: assessments.length });
                try {
                    await page.goto(assessments[i].href, { waitUntil: 'networkidle2', timeout: 20000 });
                    await page.waitForTimeout(2000);
                    await solveCurrentPageQuestions(page, io, i, assessments.length);
                } catch (err) { emit(io, { step: 'warning', message: `⚠️ خطأ في الاختبار ${i + 1}: ${err.message}`, percent: Math.round(percent), type: 'warning' }); }
            }
        }

        emit(io, { step: 'complete', message: '🎉 تم إتمام جميع الحلول بنجاح!', percent: 100, type: 'success' });
        emit(io, { step: 'done', message: '✅ يمكنك إغلاق المتصفح الآن', percent: 100, type: 'success' });
    } finally { if (browser) await browser.close().catch(() => {}); }
}

async function fillField(page, selectors, value, fieldName) {
    for (const selector of selectors) {
        try {
            const el = await page.waitForSelector(selector, { timeout: 3000 });
            if (el) {
                await el.click();
                await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control'); await page.keyboard.press('Backspace');
                await el.type(value, { delay: 60 });
                return;
            }
        } catch (e) { continue; }
    }
    throw new Error(`تعذر العثور على حقل ${fieldName}`);
}

async function submitLogin(page) {
    const selectors = ['button[type="submit"]','#loginBtn','#submitBtn','.login-btn','button.login-btn','.btn-primary','input[type="submit"]','.submit-btn'];
    for (const s of selectors) { try { const btn = await page.$(s); if (btn) { await btn.click(); return; } } catch(e) { continue; } }
    await page.keyboard.press('Enter');
}

async function navigateToAssessments(page) {
    const selectors = ['a[href*="assessment"]','a[href*="quiz"]','a[href*="test"]','a[href*="exam"]','.sidebar a[href*="assessment"]'];
    for (const s of selectors) {
        try { const el = await page.$(s); if (el) { await el.click(); await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(()=>{}); await page.waitForTimeout(2000); return; } } catch(e) { continue; }
    }
}

async function findAssessments(page) {
    const selectors = ['a[href*="assessment/"]','a[href*="quiz/"]','.assessment-card a','.quiz-card a','.card a[href*="assessment"]'];
    for (const s of selectors) {
        try {
            const links = await page.$$eval(s, els => els.filter(el => el.href && el.innerText.trim()).map(el => ({ href: el.href, title: el.innerText.trim().substring(0,100) })));
            if (links.length > 0) return links;
        } catch(e) { continue; }
    }
    return [];
}

async function solveCurrentPageQuestions(page, io, assessIndex, totalAssess) {
    const selectors = ['.question-card','.question-container','.quiz-question','[class*="question"]','.exam-question','.item-question'];
    let questionElements = [];
    for (const s of selectors) { try { const els = await page.$$(s); if (els.length > 0) { questionElements = els; break; } } catch(e) { continue; } }
    if (questionElements.length === 0) questionElements = await page.$$('[data-question], [id*="question"], .q-wrap');

    if (questionElements.length === 0) { emit(io, { step: 'no-questions', message: '⚠️ لم يتم العثور على أسئلة', percent: 60, type: 'warning' }); return; }

    for (let i = 0; i < questionElements.length; i++) {
        try {
            const basePercent = 52 + ((assessIndex / totalAssess) * 43);
            const questionPercent = basePercent + ((i / questionElements.length) * (43 / totalAssess));
            const questionText = await questionElements[i].evaluate(el => { const ts=['.question-text','.q-text','h3','h4','p','.question-title']; for(const t of ts){const q=el.querySelector(t); if(q&&q.innerText.trim()) return q.innerText.trim();} return el.innerText.trim().substring(0,500); });
            const options = await questionElements[i].evaluate(el => { const os=['.option','.choice','[class*="option"]','[class*="choice"]']; for(const s of os){const oe=el.querySelectorAll(s); if(oe.length>=2) return Array.from(oe).map((o,idx)=>({index:idx,text:o.innerText.trim()}));} return []; });

            emit(io, { step: 'question', message: `❓ السؤال ${i+1}/${questionElements.length}: ${questionText.substring(0,70)}...`, percent: Math.round(questionPercent), current: i+1, total: questionElements.length });

            if (options.length > 0) {
                let selectedIdx = -1;
                if (OPENAI_KEY) { selectedIdx = await getAIAnswer(questionText, options); }
                if (selectedIdx === -1) selectedIdx = Math.floor(Math.random() * options.length);
                await clickOption(questionElements[i], selectedIdx);
                await page.waitForTimeout(600);
            }
        } catch (err) { console.error(`Error question ${i+1}:`, err); }
    }
    await clickNavigationButton(page);
    await clickFinalSubmit(page);
}

async function clickOption(questionEl, optionIndex) {
    const selectors = ['.option','.choice','[class*="option"]','input[type="radio"] + label','input[type="checkbox"] + label'];
    for (const s of selectors) { try { const opts = await questionEl.$$(s); if (opts.length > optionIndex) { await opts[optionIndex].click(); return; } } catch(e) { continue; } }
    try { const inputs = await questionEl.$$('input[type="radio"], input[type="checkbox"]'); if (inputs.length > optionIndex) await inputs[optionIndex].click(); } catch(e) {}
}

async function clickNavigationButton(page) {
    const selectors = ['button:has-text("Next")','.next-btn','#nextBtn','.btn-next'];
    for (const s of selectors) { try { const btn = await page.$(s); if (btn) { await btn.click(); await page.waitForTimeout(1500); return; } } catch(e) { continue; } }
}

async function clickFinalSubmit(page) {
    const selectors = ['button:has-text("Submit")','.final-submit','#finalSubmit','.btn-finish'];
    for (const s of selectors) { try { const btn = await page.$(s); if (btn) { await btn.click(); await page.waitForTimeout(2000); return; } } catch(e) { continue; } }
}

async function getAIAnswer(questionText, options) {
    if (!OPENAI_KEY) return -1;
    try {
        const optionsText = options.map((opt,i)=>`${i+1}. ${opt.text}`).join('\n');
        const response = await fetch('https://api.openai.com/v1/chat/completions', { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${OPENAI_KEY}`}, body: JSON.stringify({ model:'gpt-3.5-turbo', messages:[{role:'system',content:'You are a quiz answer bot. Respond with ONLY the number of the correct answer (1-based index). Respond with just the number.'},{role:'user',content:`Question: ${questionText}\n\nOptions:\n${optionsText}\n\nAnswer (just the number):`}], max_tokens:5, temperature:0.1 }) });
        const data = await response.json();
        const match = data.choices[0].message.content.trim().match(/\d+/);
        if (match) { const num = parseInt(match[0]); if (num >= 1 && num <= options.length) return num - 1; }
        return -1;
    } catch (e) { return -1; }
}

server.listen(PORT, () => {
    console.log(`\n🎯 FAHD & DALO - Server running on http://localhost:${PORT}\n🤖 OpenAI: ${OPENAI_KEY ? 'Enabled ✅' : 'Disabled ❌'}\n`);
});