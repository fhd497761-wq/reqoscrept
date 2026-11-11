class ParticleSystem {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        this.particles = [];
        this.mouse = { x: null, y: null };
        this.resize(); this.createParticles(); this.bindEvents(); this.animate();
    }
    resize() { this.canvas.width = window.innerWidth; this.canvas.height = window.innerHeight; }
    createParticles() {
        this.particles = [];
        const area = this.canvas.width * this.canvas.height;
        const count = Math.min(Math.floor(area / 8000), 120);
        for (let i = 0; i < count; i++) {
            this.particles.push({ x: Math.random()*this.canvas.width, y: Math.random()*this.canvas.height, vx:(Math.random()-.5)*.4, vy:(Math.random()-.5)*.4, radius:Math.random()*2+.5, opacity:Math.random()*.4+.15, hue:260+Math.random()*40 });
        }
    }
    bindEvents() {
        window.addEventListener('resize', () => { this.resize(); this.createParticles(); });
        this.canvas.addEventListener('mousemove', e => { this.mouse.x = e.clientX; this.mouse.y = e.clientY; });
        this.canvas.addEventListener('mouseleave', () => { this.mouse.x = null; this.mouse.y = null; });
    }
    animate() {
        this.ctx.clearRect(0,0,this.canvas.width,this.canvas.height);
        for (const p of this.particles) {
            p.x += p.vx; p.y += p.vy;
            if (p.x<0) p.x=this.canvas.width; if(p.x>this.canvas.width) p.x=0;
            if (p.y<0) p.y=this.canvas.height; if(p.y>this.canvas.height) p.y=0;
            if (this.mouse.x !== null) { const dx=this.mouse.x-p.x, dy=this.mouse.y-p.y, dist=Math.sqrt(dx*dx+dy*dy); if(dist<200){p.vx+=dx*.00003;p.vy+=dy*.00003;} }
            const speed = Math.sqrt(p.vx*p.vx+p.vy*p.vy); if(speed>1){p.vx=p.vx/speed;p.vy=p.vy/speed;}
            this.ctx.beginPath(); this.ctx.arc(p.x,p.y,p.radius,0,Math.PI*2);
            this.ctx.fillStyle = `hsla(${p.hue},70%,65%,${p.opacity})`; this.ctx.fill();
        }
        for (let i=0;i<this.particles.length;i++) {
            for (let j=i+1;j<this.particles.length;j++) {
                const dx=this.particles[i].x-this.particles[j].x, dy=this.particles[i].y-this.particles[j].y;
                const dist=Math.sqrt(dx*dx+dy*dy), maxDist=140;
                if(dist<maxDist){ const op=(1-dist/maxDist)*.12; this.ctx.beginPath(); this.ctx.moveTo(this.particles[i].x,this.particles[i].y); this.ctx.lineTo(this.particles[j].x,this.particles[j].y); this.ctx.strokeStyle=`hsla(265,70%,65%,${op})`; this.ctx.lineWidth=.5; this.ctx.stroke(); }
            }
        }
        if (this.mouse.x!==null) { for (const p of this.particles) { const dx=this.mouse.x-p.x,dy=this.mouse.y-p.y,dist=Math.sqrt(dx*dx+dy*dy); if(dist<180){const op=(1-dist/180)*.2; this.ctx.beginPath(); this.ctx.moveTo(this.mouse.x,this.mouse.y); this.ctx.lineTo(p.x,p.y); this.ctx.strokeStyle=`hsla(265,70%,75%,${op})`; this.ctx.lineWidth=.5; this.ctx.stroke();} } }
        requestAnimationFrame(() => this.animate());
    }
}

class Timer {
    constructor() { this.startTime=null; this.interval=null; }
    start() { this.startTime=Date.now(); this.interval=setInterval(()=>{const el=Math.floor((Date.now()-this.startTime)/1000);const m=String(Math.floor(el/60)).padStart(2,'0');const s=String(el%60).padStart(2,'0');const e=document.getElementById('stat-time');if(e)e.textContent=`${m}:${s}`;},1000); }
    stop() { if(this.interval) clearInterval(this.interval); }
}

class App {
    constructor() {
        this.particles = new ParticleSystem('particles-canvas');
        this.timer = new Timer(); this.socket = io(); this.isRunning = false;
        this.initDOM(); this.bindEvents(); this.bindSocket();
    }
    initDOM() {
        this.loginCard=document.getElementById('login-card'); this.progressCard=document.getElementById('progress-card');
        this.loginForm=document.getElementById('login-form'); this.startBtn=document.getElementById('start-btn');
        this.progressBar=document.getElementById('progress-bar'); this.progressPercent=document.getElementById('progress-percent');
        this.progressLabel=document.getElementById('progress-label'); this.progressStep=document.getElementById('progress-step');
        this.logContainer=document.getElementById('log-container'); this.statsRow=document.getElementById('stats-row');
        this.statCurrent=document.getElementById('stat-current'); this.statTotal=document.getElementById('stat-total');
        this.stepOrder=['launch','navigate','credentials','login','logged','assessments','solving','complete'];
    }
    bindEvents() { this.loginForm.addEventListener('submit', e => { e.preventDefault(); this.startSolving(); }); }
    bindSocket() {
        this.socket.on('progress', data => this.updateProgress(data));
        this.socket.on('error', data => { this.addLog(data.message,'error'); this.setStepState('error'); this.stopSolving(); });
        this.socket.on('status', data => { if(!data.isRunning){this.isRunning=false;this.stopSolving();} });
    }
    async startSolving() {
        if (this.isRunning) return;
        const studentId = document.getElementById('student-id').value.trim();
        const studentPassword = document.getElementById('student-password').value.trim();
        if (!studentId || !studentPassword) { this.addLog('⚠️ يرجى إدخال البيانات','warning'); return; }
        this.isRunning = true; this.startBtn.disabled = true;
        this.startBtn.querySelector('.btn-text').classList.add('hidden');
        this.startBtn.querySelector('.btn-loader').classList.remove('hidden');
        this.loginCard.classList.add('hidden'); this.progressCard.classList.remove('hidden'); this.statsRow.classList.remove('hidden');
        this.logContainer.innerHTML = ''; this.timer.start(); this.updateProgressUI(0,'جاري البدء...');
        this.addLog('🚀 بدء عملية الحل التلقائي...','info');
        try {
            const res = await fetch('/api/solve', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({studentId, studentPassword}) });
            const result = await res.json();
            if (!result.success) throw new Error(result.error);
            this.addLog('✅ تم إرسال الطلب بنجاح...','success');
        } catch (error) { this.addLog(`❌ خطأ: ${error.message}`,'error'); this.stopSolving(); }
    }
    updateProgress(data) {
        const { percent, message, step, current, total } = data;
        this.updateProgressUI(percent, message);
        if (step) this.updateStepState(step);
        if (message) this.addLog(message, data.type || 'info');
        if (current !== undefined) this.statCurrent.textContent = current;
        if (total !== undefined) this.statTotal.textContent = total;
        if (step === 'complete' || percent >= 100) { this.addLog('🎉 اكتملت العملية!','success'); this.stopSolving(); }
    }
    updateProgressUI(percent, label) { this.progressBar.style.width=`${percent}%`; this.progressPercent.textContent=`${percent}%`; if(label)this.progressLabel.textContent=label; }
    updateStepState(step) {
        const idx = this.stepOrder.indexOf(step); if (idx === -1) return;
        const dots = document.querySelectorAll('.step-dot'); const conns = document.querySelectorAll('.step-connector');
        dots.forEach((d,i)=>{ d.classList.remove('active','completed'); if(i<idx)d.classList.add('completed'); else if(i===idx)d.classList.add('active'); });
        conns.forEach((c,i)=>{ c.classList.remove('active'); if(i<idx)c.classList.add('active'); });
        this.progressStep.textContent = this.getDesc(step);
    }
    getDesc(s) { const d={launch:'🚀 جاري تشغيل المتصفح...',navigate:'🌐 جاري فتح المنصة...',credentials:'📝 جاري إدخال البيانات...',login:'🔐 جاري تسجيل الدخول...',logged:'✅ تم تسجيل الدخول بنجاح',assessments:'🔍 جاري البحث عن الاختبارات...',finding:'📋 جاري جمع الاختبارات...',solving:'📝 جاري حل الاختبارات...',question:'❓ جاري حل الأسئلة...','ai-answer':'🤖 AI يحل السؤال...','no-questions':'⚠️ لا توجد أسئلة',complete:'🎉 اكتمل الحل بنجاح!',done:'✅ يمكنك إغلاق المتصفح',warning:'⚠️ تحذير...',error:'❌ خطأ...'}; return d[s]||s; }
    setStepState(state) { const a=document.querySelector('.step-dot.active'); if(a){a.classList.remove('active');a.classList.add(state==='error'?'error':'completed');} }
    addLog(message, type='info') {
        const entry=document.createElement('div'); entry.className=`log-entry log-${type}`;
        const now=new Date(); const time=now.toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
        entry.innerHTML=`<span class="log-time">${time}</span><span class="log-message">${message}</span>`;
        this.logContainer.appendChild(entry); this.logContainer.scrollTop=this.logContainer.scrollHeight;
    }
    stopSolving() { this.isRunning=false; this.timer.stop(); this.startBtn.disabled=false; this.startBtn.querySelector('.btn-text').classList.remove('hidden'); this.startBtn.querySelector('.btn-loader').classList.add('hidden'); }
}

document.addEventListener('DOMContentLoaded', () => { window.app = new App(); console.log('🎯 FAHD & DALO App initialized'); });