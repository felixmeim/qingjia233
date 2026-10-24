/**
 * 请假管理系统 —— 五屏结构
 *
 *   工作台(#/workbench) → 掌上校园(#/campus) → 申请记录(#/records)
 *                                            → 申请 → 自定义填写(#/form)
 *                                                    → 生成 → 截图(#/shot/<id>)
 *
 * 返回栈（手机返回手势 / 企业微信返回）：
 *   截图 → 申请记录 → 掌上校园 → 工作台
 *   自定义填写只有一条入口：申请记录底部的「申请」按钮；
 *   生成截图时会把「自定义填写」这条历史替换成「申请记录」，所以从截图返回不会经过填写页。
 */
(function () {
    'use strict';

    /* ============ 常量 ============ */
    var RECS_KEY = 'qj.records.v1';
    var DRAFT_KEY = 'leaveFormData_v2';        // 原有草稿 key，保持不变
    var FIELDS = ['name', 'leaveType', 'startTime', 'endTime', 'reason', 'applyTime', 'counselorName', 'approveTime'];
    var MAX_RECORDS = 100;
    var STATUS_TEXT = '审核通过';               // 所有生成记录一律审核通过

    var PAGES = ['workbench', 'campus', 'records', 'form', 'shot'];
    var DEPTH = { workbench: 0, campus: 1, records: 2, form: 3, shot: 3 };
    var FALLBACK = { campus: 'workbench', records: 'campus', form: 'records', shot: 'records', workbench: null };

    /* ============ 记录存储（localStorage，失败时内存兜底） ============ */
    var store = {
        items: [],
        load: function () {
            try {
                var raw = localStorage.getItem(RECS_KEY);
                var parsed = raw ? JSON.parse(raw) : null;
                if (Array.isArray(parsed)) {
                    this.items = parsed;
                } else if (parsed && Array.isArray(parsed.items)) {
                    this.items = parsed.items;
                } else {
                    this.items = [];
                }
            } catch (e) {
                this.items = [];
            }
        },
        save: function () {
            try {
                localStorage.setItem(RECS_KEY, JSON.stringify({ v: 1, items: this.items.slice(0, MAX_RECORDS) }));
                return true;
            } catch (e) {
                return false;
            }
        },
        add: function (rec) {
            this.items.unshift(rec);
            if (this.items.length > MAX_RECORDS) {
                this.items.length = MAX_RECORDS;
            }
            return this.save();
        },
        get: function (id) {
            for (var i = 0; i < this.items.length; i++) {
                if (this.items[i].id === id) {
                    return this.items[i];
                }
            }
            return null;
        },
        sorted: function () {
            return this.items.slice().sort(function (a, b) {
                return (b.createdAt || 0) - (a.createdAt || 0);
            });
        }
    };

    /* ============ DOM ============ */
    function $(id) {
        return document.getElementById(id);
    }

    var screens = {};
    var currentPage = 'workbench';
    var currentRecordId = null;
    var hideTimer = null;

    /* ============ 页面切换动画（卡片覆盖式） ============
     * 只有「进入的那一屏」在动：
     *   前进：新屏从右侧 100% 滑到 0，旧屏原地不动被盖住
     *   返回：当前屏从 0 滑到右侧 100%，露出下面那张（已在 0 位置）的上一屏
     * 这样屏幕上永远只有「完整的一屏 + 一张正在滑动的屏」，不会露出第三层或页面底色。
     */
    function showScreen(page, dir) {
        var next = screens[page];
        var prev = screens[currentPage];
        if (!next) {
            return;
        }
        if (next === prev) {
            next.style.display = 'flex';
            next.style.transform = 'translateX(0)';
            next.style.pointerEvents = 'auto';
            return;
        }

        // 1) 其余屏彻底隐藏
        PAGES.forEach(function (p) {
            var s = screens[p];
            if (!s || s === next || s === prev) {
                return;
            }
            s.style.transition = 'none';
            s.style.display = 'none';
            s.style.transform = 'translateX(0)';
            s.style.zIndex = '1';
            s.style.pointerEvents = 'none';
        });

        next.style.display = 'flex';
        if (prev) {
            prev.style.display = 'flex';
        }

        if (dir === 'back') {
            // 2b) 返回：目标屏静置在 0 垫底，当前屏滑出右侧
            next.style.transition = 'none';
            next.style.transform = 'translateX(0)';
            next.style.zIndex = '2';
            next.style.pointerEvents = 'none';
            void next.offsetWidth;
            next.style.transition = '';

            if (prev) {
                prev.style.zIndex = '3';
                prev.style.pointerEvents = 'none';
                prev.style.transition = 'none';
                prev.style.transform = 'translateX(0)';
                void prev.offsetWidth;
                prev.style.transition = '';
                requestAnimationFrame(function () {
                    prev.style.transform = 'translateX(100%)';
                });
            }
            next.style.pointerEvents = 'auto';
        } else {
            // 2a) 前进：新屏从右侧滑入，旧屏原地不动
            next.style.zIndex = '3';
            next.style.transition = 'none';
            next.style.transform = 'translateX(100%)';
            next.style.pointerEvents = 'none';
            void next.offsetWidth;
            next.style.transition = '';
            requestAnimationFrame(function () {
                next.style.transform = 'translateX(0)';
                next.style.pointerEvents = 'auto';
            });

            if (prev) {
                prev.style.zIndex = '2';
                prev.style.transition = 'none';
                prev.style.transform = 'translateX(0)';
                prev.style.pointerEvents = 'none';
                void prev.offsetWidth;
                prev.style.transition = '';
            }
        }

        currentPage = page;
        // 前进时等「新屏」滑完再把旧屏藏掉；返回时等「旧屏」滑完
        parkPrev(prev, dir === 'back' ? prev : next);
    }

    function parkPrev(prev, animatedEl) {
        if (!prev) {
            return;
        }
        animatedEl = animatedEl || prev;
        clearTimeout(hideTimer);
        var parked = false;
        var onEnd = function (e) {
            if (e.target === animatedEl && e.propertyName === 'transform') {
                park();
            }
        };
        function park() {
            if (parked) {
                return;
            }
            parked = true;
            prev.removeEventListener('transitionend', onEnd);
            clearTimeout(hideTimer);
            if (prev === screens[currentPage]) {
                return;
            }
            prev.style.transition = 'none';
            prev.style.display = 'none';
            prev.style.transform = 'translateX(0)';
            prev.style.zIndex = '1';
            void prev.offsetWidth;
            prev.style.transition = '';
        }
        animatedEl.addEventListener('transitionend', onEnd);
        hideTimer = setTimeout(park, 800);
    }
    /* ============ 路由 ============ */
    function hashOf(page, id) {
        if (page === 'workbench') {
            return '#/workbench';
        }
        if (page === 'campus') {
            return '#/campus';
        }
        if (page === 'records') {
            return '#/records';
        }
        if (page === 'form') {
            return '#/form';
        }
        return '#/shot/' + encodeURIComponent(id || '');
    }

    function parseHash() {
        var h = (location.hash || '').replace(/^#\/?/, '');
        if (h.indexOf('campus') === 0) {
            return { page: 'campus', id: null };
        }
        if (h.indexOf('records') === 0) {
            return { page: 'records', id: null };
        }
        if (h.indexOf('form') === 0) {
            return { page: 'form', id: null };
        }
        if (h.indexOf('shot') === 0) {
            return { page: 'shot', id: decodeURIComponent(h.split('/')[1] || '') };
        }
        return { page: 'workbench', id: null };
    }

    function depthOf(state) {
        if (state && typeof state.d === 'number') {
            return state.d;
        }
        return 0;
    }

    function go(page, id) {
        id = id || null;
        var d = DEPTH[page] !== undefined ? DEPTH[page] : depthOf(history.state) + 1;
        history.pushState({ qj: 1, page: page, id: id, d: d }, '', hashOf(page, id));
        render(page, id, 'forward');
    }

    function replaceWith(page, id) {
        id = id || null;
        var d = DEPTH[page] !== undefined ? DEPTH[page] : depthOf(history.state);
        history.replaceState({ qj: 1, page: page, id: id, d: d }, '', hashOf(page, id));
    }

    function backOr(page) {
        if (depthOf(history.state) > 0) {
            history.back();
        } else {
            var fb = FALLBACK[page] || FALLBACK[currentPage];
            if (fb) {
                go(fb, null);
            }
        }
    }

    function render(page, id, dir) {
        if (page === 'shot') {
            var rec = store.get(id);
            if (!rec) {
                render('records', null, dir === 'back' ? 'forward' : dir);
                replaceWith('records', null);
                return;
            }
            currentRecordId = id;
            renderShot(rec);
        } else if (page === 'records') {
            renderRecords();
        } else if (page === 'campus') {
            renderCampus();
        } else if (page === 'workbench') {
            renderWorkbench();
        }
        showScreen(page, dir || 'forward');
    }

    /* ============ 工作台 / 掌上校园 渲染 ============ */
    // 单文件版会把 assets 映射进 window.__ASSETS__，这里统一解析（多文件版原样返回）
    function assetUrl(p) {
        if (window.__ASSETS__ && window.__ASSETS__[p]) {
            return window.__ASSETS__[p];
        }
        return p;
    }

    var escapeHtml = function (s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
    };

    function gridHtml(items) {
        return items.map(function (it) {
            var cls = 'app-cell' + (it.action ? ' app-cell--tap' : '');
            var data = it.action ? ' data-action="' + it.action + '"' : '';
            var icon = it.icon
                ? '<img class="app-cell__icon" src="' + assetUrl(it.icon) + '" alt="" draggable="false">'
                : '<span class="app-cell__icon app-cell__icon--blank"></span>';
            return '<div class="' + cls + '"' + data + '>' + icon +
                '<div class="app-cell__label">' + escapeHtml(it.label) + '</div></div>';
        }).join('');
    }

    var CAMPUS_SECTIONS = [
        {
            title: '教学科研',
            items: [
                { label: '我的课表', icon: 'assets/icons/campus/course-table.png' },
                { label: '期末报告', icon: 'assets/icons/campus/final-report.png' },
                { label: '移动教务', icon: 'assets/icons/campus/mobile-edu.png' },
                { label: '移动图书馆', icon: 'assets/icons/campus/mobile-lib.png' },
                { label: '实验系统', icon: 'assets/icons/campus/lab.png' },
                { label: '心理系统', icon: 'assets/icons/campus/psychology.png' }
            ]
        },
        {
            title: '办公应用',
            items: [
                { label: '通知公示', icon: 'assets/icons/campus/notice.png' },
                { label: '投票/问卷', icon: 'assets/icons/campus/vote.png' },
                { label: '学生请假申请', icon: 'assets/icons/campus/leave-apply.png', action: 'open-records' },
                { label: '移动迎新', icon: 'assets/icons/campus/welcome.png' },
                { label: '勤工助学', icon: 'assets/icons/campus/work-study.png' },
                { label: '一表通系统', icon: 'assets/icons/campus/form-system.png' }
            ]
        },
        {
            title: '数据服务',
            items: [
                { label: '我的考试', icon: 'assets/icons/campus/exam.png' },
                { label: '我的成绩', icon: 'assets/icons/campus/score.png' },
                { label: '一卡通消费', icon: 'assets/icons/campus/card.png' },
                { label: '我的科研', icon: 'assets/icons/campus/research.png' }
            ]
        },
        {
            title: '校园助手',
            items: [
                { label: '失物招领', icon: 'assets/icons/campus/lost-found.png' },
                { label: '学校班车', icon: 'assets/icons/campus/shuttle.png' },
                { label: '校历', icon: 'assets/icons/campus/calendar.png' },
                { label: '发票助手', icon: 'assets/icons/campus/invoice.png' },
                { label: '维修申请', icon: 'assets/icons/campus/repair.png' }
            ]
        }
    ];

    var WORKBENCH_SECTIONS = [
        {
            title: '效率工具',
            items: [
                { label: '日程', icon: 'assets/icons/workbench/schedule.png' },
                { label: '会议', icon: 'assets/icons/workbench/meeting.png' },
                { label: '微盘', icon: 'assets/icons/workbench/drive.png' },
                { label: '收集表', icon: 'assets/icons/workbench/form.png' }
            ]
        },
        {
            title: '警院微应用',
            layout: 'app-row',
            items: [
                { label: '掌上校园', icon: 'assets/icons/workbench/campus-app.png', action: 'open-campus' }
            ]
        },
        {
            title: '智能办公',
            titleSuffix: 'AI+',
            items: [
                { label: '智能文档', icon: 'assets/icons/workbench/ai-doc.png' },
                { label: '智能表格', icon: 'assets/icons/workbench/ai-sheet.png' },
                { label: '智能总结', icon: 'assets/icons/workbench/ai-summary.png' },
                { label: '智能机器人', icon: 'assets/icons/workbench/ai-bot.png' },
                { label: '记录面聊', icon: 'assets/icons/workbench/record-chat.png' },
                { label: '服务总结', icon: 'assets/icons/workbench/service-summary.png' }
            ]
        },
        {
            title: '',
            layout: 'app-row',
            items: [
                { label: '企业小助手', icon: 'assets/icons/workbench/assistant.png' },
                { label: '手机版', icon: 'assets/icons/workbench/mobile.png' }
            ]
        }
    ];

    function renderCampus() {
        var host = $('campus-body');
        if (!host || host.getAttribute('data-rendered') === '1') {
            return;
        }
        host.innerHTML = CAMPUS_SECTIONS.map(function (sec) {
            return '<section class="campus-section">' +
                '<h2 class="campus-section__title">' + escapeHtml(sec.title) +
                '<span class="campus-section__chev"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"></path></svg></span>' +
                '</h2>' +
                '<div class="campus-grid">' + gridHtml(sec.items) + '</div>' +
                '</section>';
        }).join('');
        host.setAttribute('data-rendered', '1');
    }

    function renderWorkbench() {
        var host = $('workbench-body');
        if (!host || host.getAttribute('data-rendered') === '1') {
            return;
        }
        host.innerHTML = WORKBENCH_SECTIONS.map(function (sec) {
            var head = sec.title
                ? '<div class="wb-card__head"><span class="wb-card__title">' + escapeHtml(sec.title) +
                  '</span>' + (sec.titleSuffix ? '<span class="wb-card__suffix">' + escapeHtml(sec.titleSuffix) + '</span>' : '') + '</div>'
                : '';
            var cls = sec.layout === 'app-row' ? 'wb-grid wb-grid--big' : 'wb-grid';
            return '<section class="wb-card">' + head + '<div class="' + cls + '">' + gridHtml(sec.items) + '</div></section>';
        }).join('');
        host.setAttribute('data-rendered', '1');
    }

    /* ============ 表单页（原有逻辑） ============ */
    var pageForm = null;
    var pageResult = null;
    var generateBtn = null;
    var navBackArrow = null;
    var navBackX = null;

    function saveData() {
        var data = {};
        FIELDS.forEach(function (id) {
            var input = $(id);
            if (input) {
                data[id] = input.value;
            }
        });
        try {
            localStorage.setItem(DRAFT_KEY, JSON.stringify(data));
        } catch (e) { /* 忽略配额错误 */ }
    }

    function loadSavedData() {
        var savedData = null;
        try {
            savedData = localStorage.getItem(DRAFT_KEY);
        } catch (e) {
            savedData = null;
        }
        if (!savedData) {
            return;
        }
        try {
            var data = JSON.parse(savedData);
            FIELDS.forEach(function (id) {
                var input = $(id);
                if (input && data[id]) {
                    input.value = data[id];
                }
            });
        } catch (e) { /* 数据损坏则忽略 */ }
    }

    function readForm() {
        var data = {};
        FIELDS.forEach(function (id) {
            var input = $(id);
            data[id] = input ? input.value : '';
        });
        return data;
    }

    function validateForm() {
        return FIELDS.every(function (id) {
            var input = $(id);
            return input && input.value.trim() !== '';
        });
    }

    /* ============ 生成记录页 ============ */
    var filterValue = 'all';
    var recordsScrollTop = 0;

    function formatDateTime(dateTimeStr, includeSeconds) {
        if (!dateTimeStr) {
            return '';
        }
        var date = new Date(dateTimeStr);
        if (isNaN(date.getTime())) {
            return dateTimeStr;
        }
        var y = date.getFullYear();
        var m = String(date.getMonth() + 1).padStart(2, '0');
        var d = String(date.getDate()).padStart(2, '0');
        var h = String(date.getHours()).padStart(2, '0');
        var min = String(date.getMinutes()).padStart(2, '0');
        var formatted = y + '-' + m + '-' + d + ' ' + h + ':' + min;
        if (includeSeconds) {
            formatted += ':00';
        }
        return formatted;
    }

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) {
            node.className = className;
        }
        if (text !== undefined && text !== null) {
            node.textContent = text;
        }
        return node;
    }

    function buildCard(rec) {
        var form = rec.form || {};

        var card = el('article', 'rec-card');
        card.setAttribute('data-id', rec.id);
        card.setAttribute('role', 'button');
        card.setAttribute('tabindex', '0');

        var head = el('div', 'rec-card__head');
        head.appendChild(el('h3', 'rec-card__title', form.leaveType || '请假'));
        card.appendChild(head);

        card.appendChild(el('div', 'rec-card__divider'));

        var body = el('div', 'rec-card__body');

        var rowStart = el('div', 'rec-row');
        rowStart.appendChild(el('span', 'rec-row__k', '开始时间:'));
        rowStart.appendChild(el('span', 'rec-row__v', formatDateTime(form.startTime, true)));
        body.appendChild(rowStart);

        var rowEnd = el('div', 'rec-row');
        rowEnd.appendChild(el('span', 'rec-row__k', '结束时间:'));
        rowEnd.appendChild(el('span', 'rec-row__v', formatDateTime(form.endTime, true)));
        body.appendChild(rowEnd);

        var rowReason = el('div', 'rec-row rec-row--reason');
        rowReason.appendChild(el('span', 'rec-row__k', '请假理由：'));
        rowReason.appendChild(el('span', 'rec-row__v', form.reason || ''));
        body.appendChild(rowReason);

        body.appendChild(el('div', 'rec-card__status', STATUS_TEXT));
        card.appendChild(body);

        card.addEventListener('click', function () {
            go('shot', rec.id);
        });

        return card;
    }

    function renderRecords() {
        var listEl = $('rec-list');
        var emptyEl = $('rec-empty');
        var all = store.sorted();
        var list = all.filter(function (r) {
            if (filterValue === 'pass') {
                return r.status === 'pass' || !r.status;
            }
            return true;
        });

        listEl.innerHTML = '';
        list.forEach(function (rec) {
            listEl.appendChild(buildCard(rec));
        });

        if (!list.length) {
            emptyEl.hidden = false;
            emptyEl.querySelector('p').textContent = all.length
                ? '没有符合条件的状态记录'
                : '暂无申请记录';
        } else {
            emptyEl.hidden = true;
        }

        var body = $('rec-scroll');
        if (body) {
            body.scrollTop = recordsScrollTop;
        }
    }

    /* ============ 截图页 ============ */
    function renderShot(rec) {
        var data = rec.form || {};

        $('display-leaveType').textContent = data.leaveType || '';
        $('display-reason').textContent = data.reason || '';
        $('display-startTime').textContent = formatDateTime(data.startTime, true);
        $('display-endTime').textContent = formatDateTime(data.endTime, true);
        $('display-applyTime').textContent = formatDateTime(data.applyTime, false);
        $('display-approveTime').textContent = formatDateTime(data.approveTime, false);
        $('display-applyName').textContent = data.name || '';
        $('display-counselorName').textContent = data.counselorName || '';
        var userName = $('display-userName');
        if (userName) {
            userName.textContent = data.name || '';
        }

        var sc = $('scroll-content');
        if (sc) {
            sc.scrollTop = 0;
        }
    }

    /* ============ 生成 ============ */
    function createRecord(data) {
        var rec = {
            id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            createdAt: Date.now(),
            form: data,
            status: 'pass'
        };
        store.add(rec);
        return rec;
    }

    /* ============ 事件绑定 ============ */
    function bindEvents() {
        FIELDS.forEach(function (id) {
            var input = $(id);
            if (input) {
                input.addEventListener('input', saveData);
            }
        });

        generateBtn.addEventListener('click', function () {
            if (!validateForm()) {
                alert('请填写完整必填项！');
                return;
            }
            var data = readForm();
            var rec = createRecord(data);
            // 把「自定义填写」这条历史直接替换成「截图页」：
            //   - 返回时落在「申请记录」（不经过填写页、也不会多出一条重复记录页）
            //   - 填表页只能从「申请」进入，符合「有且仅有点击申请图标能进入」
            history.replaceState(
                { qj: 1, page: 'shot', id: rec.id, d: DEPTH.shot },
                '',
                hashOf('shot', rec.id)
            );
            render('shot', rec.id, 'forward');
        });

        navBackArrow.addEventListener('click', function () {
            backOr('shot');
        });
        navBackX.addEventListener('click', function () {
            go('workbench', null);
        });

        // 申请记录页导航
        $('rec-back').addEventListener('click', function () {
            recordsScrollTop = $('rec-scroll').scrollTop;
            backOr('records');
        });
        $('rec-close').addEventListener('click', function () {
            go('campus', null);
        });
        $('rec-apply').addEventListener('click', function () {
            recordsScrollTop = $('rec-scroll').scrollTop;
            go('form', null);
        });

        // 状态筛选
        var filterBtn = $('rec-filter-btn');
        var filterMenu = $('rec-filter-menu');
        var filterLabel = $('rec-filter-label');

        filterBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            var open = filterMenu.hidden;
            filterMenu.hidden = !open;
            filterBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        });

        filterMenu.addEventListener('click', function (e) {
            var li = e.target.closest('li[data-value]');
            if (!li) {
                return;
            }
            filterValue = li.getAttribute('data-value');
            filterLabel.textContent = li.textContent;
            Array.prototype.forEach.call(filterMenu.children, function (item) {
                item.setAttribute('aria-selected', item === li ? 'true' : 'false');
            });
            filterMenu.hidden = true;
            filterBtn.setAttribute('aria-expanded', 'false');
            renderRecords();
        });

        document.addEventListener('click', function () {
            if (!filterMenu.hidden) {
                filterMenu.hidden = true;
                filterBtn.setAttribute('aria-expanded', 'false');
            }
        });

        // 掌上校园：点「学生请假申请」→ 申请记录
        $('screen-campus').addEventListener('click', function (e) {
            var cell = e.target.closest('[data-action]');
            if (!cell) {
                return;
            }
            if (cell.getAttribute('data-action') === 'open-records') {
                go('records', null);
            }
        });

        $('campus-back').addEventListener('click', function () {
            backOr('campus');
        });
        $('campus-more').addEventListener('click', function () {
            /* 与原 App 一致：无操作 */
        });

        // 工作台顶部轮播卡：双击（掌上校园图标等可点区域以外）切页
        var bannerAlt = false;
        var lastSlideAt = 0;
        function slideBanner() {
            // 触屏上「两次点击」会同时触发 touchend 双击检测 和 浏览器合成的 dblclick，
            // 这里 400ms 内只允许切换一次，否则会切两次等于没动
            var now = Date.now();
            if (now - lastSlideAt < 400) {
                return;
            }
            lastSlideAt = now;
            // 有双击意图时，取消「首触自动全屏」，避免全屏动画打断手势
            try {
                document.dispatchEvent(new CustomEvent('qj:cancelfs'));
            } catch (e) { /* ignore */ }
            bannerAlt = !bannerAlt;
            var banner = $('wb-banner');
            if (banner) {
                banner.classList.toggle('wb-banner--alt', bannerAlt);
            }
        }
        function isInteractive(target) {
            return !!(target.closest && (target.closest('[data-action]') || target.closest('.wb-tabbar')));
        }
        $('screen-workbench').addEventListener('dblclick', function (e) {
            if (isInteractive(e.target)) {
                return;
            }
            slideBanner();
        });
        // 手机上没有 dblclick，用「两次 tap 间隔 < 320ms」模拟双击
        var lastTapAt = 0;
        var lastTapX = 0;
        var lastTapY = 0;
        $('screen-workbench').addEventListener('touchend', function (e) {
            if (isInteractive(e.target) || !e.changedTouches || !e.changedTouches.length) {
                return;
            }
            var t = e.changedTouches[0];
            var now = Date.now();
            if (now - lastTapAt < 320 && Math.abs(t.clientX - lastTapX) < 30 && Math.abs(t.clientY - lastTapY) < 30) {
                slideBanner();
                lastTapAt = 0;
            } else {
                lastTapAt = now;
                lastTapX = t.clientX;
                lastTapY = t.clientY;
            }
        });

        // 工作台：点「掌上校园」→ 掌上校园
        $('screen-workbench').addEventListener('click', function (e) {
            var cell = e.target.closest('[data-action]');
            if (!cell) {
                return;
            }
            if (cell.getAttribute('data-action') === 'open-campus') {
                go('campus', null);
            }
        });

        window.addEventListener('popstate', function (e) {
            var st = e.state;
            if (!st || !st.page) {
                var route = parseHash();
                render(route.page, route.id, 'back');
                return;
            }
            render(st.page, st.id, 'back');
        });
    }


    /* ---------- 手机端：首次触摸自动进入沉浸全屏（浏览器标签页里去掉地址栏） ---------- */
    (function __fsBoot() {
        try {
            var isStandalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
            var isWeCom = /wxwork/i.test(navigator.userAgent);
            var isMobile = window.innerWidth <= 600;
            if (isStandalone || isWeCom || !isMobile) {
                return;
            }
            var done = false;
            function isFormTarget(t) {
                if (!t || !t.tagName) {
                    return false;
                }
                var tag = t.tagName.toLowerCase();
                if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button') {
                    return true;
                }
                return !!(t.closest && t.closest('input,textarea,select,button'));
            }
            function requestFs(ev) {
                if (done) {
                    return;
                }
                // 点在输入框/按钮上时不抢手势：否则键盘可能被全屏动画打断
                if (ev && isFormTarget(ev.target)) {
                    return;
                }
                done = true;
                document.removeEventListener('touchend', requestFs, true);
                document.removeEventListener('pointerup', requestFs, true);
                if (fsTimer) {
                    clearTimeout(fsTimer);
                    fsTimer = null;
                }
                var el = document.documentElement;
                var fn = el.requestFullscreen || el.webkitRequestFullscreen;
                if (!fn) {
                    return;
                }
                try {
                    var p = fn.call(el);
                    if (p && p.catch) {
                        p.catch(function () {});
                    }
                } catch (e) { /* 某些 WebView 不支持，忽略 */ }
            }
            function scheduleFs(ev) {
                if (done || fsTimer) {
                    return;
                }
                if (ev && isFormTarget(ev.target)) {
                    return;
                }
                fsTimer = setTimeout(function () {
                    fsTimer = null;
                    requestFs();
                }, 420);
            }
            document.addEventListener('touchend', scheduleFs, true);
            document.addEventListener('pointerup', scheduleFs, true);
        } catch (e) { /* 忽略 */ }
    })();

    /* ============ 启动 ============ */
    var BUILD_TAG = 'leave-app build 2026-10-24 v3 (cover-transition)';

    function boot() {
        try { console.log(BUILD_TAG); } catch (e) { /* ignore */ }
        PAGES.forEach(function (p) {
            screens[p] = $('screen-' + p);
        });
        pageForm = $('page-form');
        pageResult = $('page-result');
        generateBtn = $('generate-btn');
        navBackArrow = $('nav-back-arrow');
        navBackX = $('nav-back-x');

        store.load();
        loadSavedData();
        bindEvents();

        // file:// 打开时没有 service worker（手机本地文件模式），跳过注册避免报错
        var canUseSW = location.protocol === 'http:' || location.protocol === 'https:';
        if ('serviceWorker' in navigator && canUseSW) {
            window.addEventListener('load', function () {
                navigator.serviceWorker.register('./service-worker.js')
                    .then(function (registration) {
                        console.log('ServiceWorker 注册成功:', registration.scope);
                    })
                    .catch(function (err) {
                        console.log('ServiceWorker 注册失败:', err);
                    });
            });
        }

        if (/wxwork/i.test(navigator.userAgent)) {
            document.body.classList.add('is-wxwork');
        }

        var route = parseHash();
        if (route.page === 'shot') {
            var rec = store.get(route.id);
            if (rec) {
                currentRecordId = route.id;
                renderShot(rec);
                replaceWith('shot', route.id);
                showScreen('shot');
                return;
            }
            route = { page: 'workbench', id: null };
        }
        if (route.page !== 'workbench') {
            replaceWith(route.page, route.id);
            render(route.page, route.id, 'forward');
            return;
        }
        renderWorkbench();
        replaceWith('workbench', null);
        // 首屏之外的屏先彻底隐藏，避免任何残留层在过场里露出
        PAGES.forEach(function (p) {
            if (screens[p] && p !== 'workbench') {
                screens[p].style.display = 'none';
            }
        });
        showScreen('workbench');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
