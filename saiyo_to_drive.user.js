// ==UserScript==
// @name         採用媒体 → Drive 連番保存
// @namespace    korabo.rpo
// @version      4.4
// @updateURL    https://raw.githubusercontent.com/sakaisho1rodesu-sys/korabo-rpo-drive/main/saiyo_to_drive.user.js
// @downloadURL  https://raw.githubusercontent.com/sakaisho1rodesu-sys/korabo-rpo-drive/main/saiyo_to_drive.user.js
// @description  Green / リクナビHRTech / doda / エンエージェント / CIRCUS の管理画面から応募書類を取得し、Driveに連番フォルダを作って保存、推薦者台帳へ１行追加する
// @match        https://www.green-japan.com/client/managements/users*
// @match        https://ats.hrtech.rikunabi.com/*
// @match        https://assist.doda.jp/DodaAssistR/ApplicantManagement/*
// @match        https://hire-hub.io/candidates*
// @match        https://circus-job.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ===== 設定 =====
  var GAS_URL = 'https://script.google.com/macros/s/AKfycbz_S1hjHkJ4Izc5NRWUE5d0hc3mSuJRU0NErhEKQihZQMUTg4V_o536jjCbBPNZip6d/exec';
  // トークンと対象社名は、公開しないようコードに書かず、Tampermonkeyの保存領域に入れる（各ブラウザで最初に1回だけ設定）
  function gasToken() { return String(GM_getValue('gas_token', '') || '').trim(); }

  // dodaは同じ画面で複数クライアントを扱うため、ログイン中のアカウント（画面右上の社名）を照合する。
  // ここに書いた社名以外では保存できない。GAS側でも同じ照合をしている
  var DODA_ALLOWED_COMPANY = String(GM_getValue('doda_allowed', '') || '')
    .split(/[,、\n]/).map(function (x) { return x.trim(); }).filter(Boolean);

  // 設定。パネルの下の「設定」ボタンから開く（Tampermonkeyのメニューにも同じ項目を出す）
  function askToken() {
    var v = prompt('GASのトークンを入力してください', gasToken());
    if (v === null) return;
    GM_setValue('gas_token', v.trim());
    alert('GASトークンを保存しました。画面を読み込み直します。');
    location.reload();
  }
  function askCompany() {
    var v = prompt('保存を許可するdodaの社名を入力してください（複数は「,」区切り）', DODA_ALLOWED_COMPANY.join(','));
    if (v === null) return;
    GM_setValue('doda_allowed', v.trim());
    alert('対象の社名を保存しました。画面を読み込み直します。');
    location.reload();
  }
  try {
    GM_registerMenuCommand('GASトークンを設定', askToken);
    GM_registerMenuCommand('doda対象の社名を設定', askCompany);
  } catch (e) {}

  var PANEL_ID = 'korabo-saiyo-panel';
  var STORE_KEY = 'korabo_saiyo_panel';

  // Greenだけ、応募のきっかけを選んでから保存する。
  // 選んだ値がDriveのフォルダ名と台帳の経由に入る（例 Green（自主応募））
  var ROUTES = [
    { value: '自主応募', label: '自主応募' },
    { value: '話を聞きたい', label: '話を聞きたい' },
    { value: 'スカウト', label: 'スカウト経由' }
  ];

  // ===== 媒体の判定 =====

  var host = location.hostname;
  var SITE =
    /green-japan\.com$/.test(host) ? 'green' :
    /hrtech\.rikunabi\.com$/.test(host) ? 'rikunabi' :
    /assist\.doda\.jp$/.test(host) ? 'doda' :
    /hire-hub\.io$/.test(host) ? 'hirehub' :
    /circus-job\.com$/.test(host) ? 'circus' : '';

  if (!SITE) return;

  var THEME = {
    green:    { label: 'Green → Drive',   color: '#1a7f37', key: 'G' },
    rikunabi: { label: 'リクナビ → Drive', color: '#1565c0', key: 'R' },
    doda:     { label: 'doda → Drive',    color: '#c2410c', key: 'D' },
    hirehub:  { label: 'エン → Drive',     color: '#6b21a8', key: 'E' },
    circus:   { label: 'CIRCUS → Drive',  color: '#0f766e', key: 'C' }
  }[SITE];

  // ===== 共通の道具 =====

  /** 社名を照合用にそろえる。全角英数を半角にし、空白を落とす */
  function normCompany(s) {
    return String(s || '')
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (c) {
        return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
      })
      .replace(/[\s\u3000]/g, '')
      .toLowerCase();
  }

  /**
   * dodaのログイン中の企業名。
   *
   * 画面右上の社名を最優先で使う。応募者詳細画面にはこの要素が無く（ヘッダーはロゴだけ）、
   * 以前はそこで「社名を読み取れません」となり保存できなかった（2026-09-24に対応）。
   * 読めないときは、応募書類のファイル名に入っている宛先から取る。
   * 例　【応募書類】賈鵬様_◯◯株式会社御中.pdf
   * 宛先はその書類そのものに付いているため、セッションの社名より確実な照合先になる。
   */
  function dodaCompanyName() {
    var el = document.querySelector('p.header-connect-menu__company');
    var name = el ? (el.innerText || '').trim() : '';
    if (name) return name;
    return dodaCompanyFromFileName();
  }

  /** 応募書類のファイル名から「◯◯御中」の宛先を取り出す */
  function dodaCompanyFromFileName() {
    var links = [].slice.call(
      document.querySelectorAll('a[href*="FileDownload"], a[href*="PDFDownload"]'));

    for (var i = 0; i < links.length; i++) {
      var src = (links[i].textContent || '') + ' ';
      try { src += decodeURIComponent(links[i].getAttribute('href') || ''); } catch (e) {}

      var m = src.match(/_([^_\/]+?)御中\.pdf/);
      if (m) return m[1].trim();

      // 2026-11-06 以降の形　例 ◯◯株式会社様_中村裕史様_推薦書類一式_04998855.pdf
      // 先頭の「◯◯株式会社様」から社名を取る。候補者名の「様」とは混ざらないよう、法人名を含むものに限る
      var m2 = src.match(/(?:^|[\/_])([^_\/]*?(?:株式会社|有限会社|合同会社)[^_\/]*?)(?:御中|様)(?=_|\.pdf)/);
      if (m2) return m2[1].trim();
    }
    return '';
  }

  /** 社名をどこから読んだか。画面に出すときの補足に使う */
  function dodaCompanySource() {
    if (document.querySelector('p.header-connect-menu__company')) return '画面の社名';
    if (dodaCompanyFromFileName()) return '応募書類の宛先';
    return '';
  }

  /** アカウント欄の色と文言を、いまの読み取り結果に合わせて書き直す */
  function paintDodaAccount(accEl, btn) {
    if (!accEl) return;

    var name = dodaCompanyName();
    var ng = !dodaCompanyOk();
    var unset = !DODA_ALLOWED_COMPANY.length;
    var src = dodaCompanySource();

    // 同じ内容のときは何も書き換えない。書き換えると画面の変化として検知され、
    // 監視処理が自分自身を呼び続けて画面が固まる（白くなる）原因になる（2026-11-06）
    var text = unset ? '対象の社名が未設定です（Tampermonkeyメニューの「doda対象の社名を設定」）' : (ng ? '対象外のアカウントです　' : '対象アカウント　')
      + (name || '社名を読み取れません')
      + (src ? '（' + src + '）' : '');
    if (unset) text = '対象の社名が未設定です（Tampermonkeyメニューの「doda対象の社名を設定」）';

    if (accEl.textContent !== text) {
      accEl.style.background = ng ? '#fdecea' : '#eef7f0';
      accEl.style.border = '1px solid ' + (ng ? '#f5a19a' : '#bfe3cb');
      accEl.style.color = ng ? '#b3261e' : '#1a7f37';
      accEl.textContent = text;
    }

    if (btn && btn.disabled !== ng) {
      btn.disabled = ng;
      btn.style.opacity = ng ? '0.45' : '1';
      btn.style.cursor = ng ? 'not-allowed' : 'pointer';
    }
    return !ng;
  }

  /**
   * 応募書類のリンクは、タブを切り替えたあとや読み込みの途中に現れることがある。
   * 画面の変化を見て読み直し、読めるようになった時点で緑に変えてボタンを使えるようにする。
   */
  function watchDodaAccount(accEl, btn) {
    if (!accEl) return;

    var stop = false;
    var done = function () {
      if (stop) return true;
      if (dodaCompanyOk()) { stop = true; return true; }
      return false;
    };

    var mo = null;
    var pending = null;
    try {
      mo = new MutationObserver(function (muts) {
        // 自分のパネルの中の変化は無視する（自分で起こした変化に反応し続けないため）
        var panel = document.getElementById(PANEL_ID);
        var outside = false;
        for (var i = 0; i < muts.length; i++) {
          if (!panel || !panel.contains(muts[i].target)) { outside = true; break; }
        }
        if (!outside || pending) return;

        // 画面の変化のたびに読み直さず、落ち着いてから1回だけ読む
        pending = setTimeout(function () {
          pending = null;
          paintDodaAccount(accEl, btn);
          if (done() && mo) { mo.disconnect(); mo = null; }
        }, 500);
      });
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (e) {}

    // 変化が起きない作りの画面もあるため、しばらくは定期的にも見る
    var n = 0;
    var timer = setInterval(function () {
      n++;
      paintDodaAccount(accEl, btn);
      if (done() || n > 20) {
        clearInterval(timer);
        if (mo) { mo.disconnect(); mo = null; }
      }
    }, 1000);
  }

  function dodaCompanyOk() {
    var now = normCompany(dodaCompanyName());
    if (!now) return false;
    for (var i = 0; i < DODA_ALLOWED_COMPANY.length; i++) {
      if (normCompany(DODA_ALLOWED_COMPANY[i]) === now) return true;
    }
    return false;
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result).split(',')[1]); };
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  function fileNameFrom(res, fallback) {
    var cd = res.headers.get('content-disposition') || '';
    var m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
    if (!m) return fallback;
    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
  }

  function postToGas(payload) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: 'POST',
        url: GAS_URL,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        data: JSON.stringify(payload),
        onload: function (res) {
          try { resolve(JSON.parse(res.responseText)); return; } catch (e) {}

          // JSONで返らなかった場合は、原因が分かるように中身を出す
          var body = String(res.responseText || '').replace(/\s+/g, ' ').slice(0, 200);
          var where = res.finalUrl && res.finalUrl !== GAS_URL ? '　転送先 ' + res.finalUrl.slice(0, 60) : '';
          reject(new Error('GASの応答を読めませんでした（HTTP ' + res.status + '）' + where + '　応答 ' + (body || '（空）')));
        },
        onerror: function (res) {
          reject(new Error('GASへ送信できませんでした（HTTP ' + ((res && res.status) || 0) +
                           '）。TampermonkeyのドメインアクセスとGAS_URLをご確認ください。'));
        },
        ontimeout: function () { reject(new Error('GASへの送信がタイムアウトしました。')); },
        timeout: 120000
      });
    });
  }

  function wait(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function textLines(el) {
    return String(el.innerText || '')
      .split('\n')
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s !== ''; });
  }

  // ===== 媒体ごとの処理 =====

  var ADAPTERS = {

    // ---------- Green ----------
    green: {
      manual: true,
      buttonText: 'この応募者をDriveへ保存',
      idle: '応募者と応募のきっかけを選んでから押してください。',

      collect: function () {
        var m = location.search.match(/job_apply_id=(\d+)/);
        var id = m ? m[1] : '';
        var lines = textLines(document.body);
        var out = { id: id, name: '', jobTitle: '', agentRaw: '', applyDate: '' };

        var i = lines.indexOf('個人情報');
        if (i >= 0) {
          var j = lines.indexOf('氏名', i);
          if (j >= 0 && lines[j + 1]) out.name = lines[j + 1];

          var k = lines.indexOf('メールアドレス', i);
          if (k >= 0) {
            for (var n = k + 1; n < Math.min(k + 5, lines.length); n++) {
              if (lines[n] === '※非表示' || lines[n] === '未記入') continue;
              out.jobTitle = lines[n];
              break;
            }

            // 応募日は求人名の直後に出る。個人情報の先頭から探すと
            // 生年月日を拾ってしまうため、メールアドレス以降だけを見る
            var d = lines.slice(k).join('\n').match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
            if (d) out.applyDate = d[1] + '/' + d[2] + '/' + d[3];
          }

          // 一覧行の「応募日:2026/08/14」からも拾えるようにしておく
          if (!out.applyDate) {
            var d2 = document.body.innerText.match(/応募日[:：]\s*(\d{4})\/(\d{1,2})\/(\d{1,2})/);
            if (d2) out.applyDate = d2[1] + '/' + d2[2] + '/' + d2[3];
          }
        }
        return out;
      },

      fetchFiles: function (info) {
        // 1) Greenが出力する履歴書PDF  2) 応募者がメッセージに添付した履歴書・職務経歴書
        // どちらかが取れれば進める。両方とも取れなかったときだけエラーにする
        var errors = [];
        function grab(url, fallbackName) {
          return fetch(url, { credentials: 'include' })
            .then(function (r) {
              if (!r.ok) throw new Error(fallbackName + ' を取得できませんでした（' + r.status + '）');
              var name = fileNameFrom(r, fallbackName);
              return r.blob().then(function (b) {
                if (b.type.indexOf('pdf') < 0 && !/\.(docx?|xlsx?)$/i.test(name)) {
                  throw new Error(name + ' がPDF以外で返りました。ログイン状態を確認してください。');
                }
                return blobToBase64(b).then(function (b64) { return { base64: b64, fileName: name }; });
              });
            })
            .catch(function (e) { errors.push(String(e.message || e)); return null; });
        }

        var jobs = [grab('/client/user_resume_pdf/job_apply/' + info.id, 'Green履歴書_' + info.id + '.pdf')];
        var seen = {};
        Array.prototype.forEach.call(
          document.querySelectorAll('a[href*="/message_threads/"][href*="/files/"]'), function (a) {
            if (seen[a.href]) return;
            seen[a.href] = true;
            var label = String(a.innerText || '').trim() || '添付.pdf';
            jobs.push(grab(a.href, label));
          });

        return Promise.all(jobs).then(function (list) {
          var files = list.filter(Boolean);
          // 同名ファイルが重ならないように連番を付ける
          var used = {};
          files.forEach(function (f) {
            var base = f.fileName, n = 1;
            while (used[f.fileName]) { n++; f.fileName = base.replace(/(\.[^.]+)$/, '_' + n + '$1'); }
            used[f.fileName] = true;
          });
          if (!files.length) throw new Error(errors.join(' / ') || 'PDFを取得できませんでした。');
          if (errors.length) console.warn('[korabo] 一部の書類を取得できませんでした:', errors);
          return files;
        });
      }
    },

    // ---------- リクナビHRTech ----------
    rikunabi: {
      manual: true,
      buttonText: 'この候補者をDriveへ保存',
      idle: '候補者詳細を開いてから押してください。',

      collect: function () {
        function val(n) {
          var el = document.querySelector('input[name="' + n + '"]');
          return el ? String(el.value || '').trim() : '';
        }
        // URLの候補者IDを正とする。画面の入力欄が前の人のまま残っていないか照合する
        var m = location.pathname.match(/\/candidate\/(\d+)/);
        var urlId = m ? m[1] : '';
        var id = val('downloadCandidateIds').replace(/[^0-9]/g, '');
        if (urlId && id && urlId !== id) {
          throw new Error('画面の切り替えが終わっていません。数秒待ってからもう一度押してください。');
        }
        if (!id) id = urlId;
        var agent = val('agentId');
        if (!agent) {
          var c = document.querySelector('input[name="agentRoute"]:checked');
          var lab = c && (c.closest('label') || c.parentElement);
          if (lab) agent = String(lab.innerText || '').trim();
        }
        return {
          id: id,
          name: val('name'),
          age: val('age'),
          jobTitle: val('jobOfferId'),
          agentRaw: agent,
          applyDate: val('entryDate')
        };
      },

      fetchFiles: function (info) {
        // 毎回かならずサーバーから取り直す（ブラウザの保存済み応答を使わない）
        var url = '/api/client/analysis/download/bulkresume?downloadCandidateIds=' + info.id
          + '&_=' + Date.now();
        return fetch(url, { credentials: 'include', cache: 'no-store' }).then(function (r) {
          if (!r.ok) throw new Error('レジュメを取得できませんでした（' + r.status + '）');
          var name = fileNameFrom(r, 'resume_' + info.id + '.zip');
          return r.blob().then(function (b) {
            if (!b.size) throw new Error('レジュメが登録されていないようです。');
            return blobToBase64(b).then(function (b64) { return [{ base64: b64, fileName: name }]; });
          });
        });
      }
    },

    // ---------- doda ----------
    // 応募者情報（キャリアシート）の画面で使う。推薦書類PDFへの直リンクを取得して保存する
    doda: {
      manual: true,
      buttonText: 'この応募者をDriveへ保存',
      idle: '応募者情報の画面を開いてから押してください。',

      collect: function () {
        var t = document.body.innerText;
        function pick(re) { var m = t.match(re); return m ? m[1].trim() : ''; }

        var lines = textLines(document.body);
        var name = '';
        for (var i = 0; i < lines.length - 1; i++) {
          // カナ表記の行の次が漢字の氏名
          if (/^[ァ-ヶー]+[\s　]+[ァ-ヶー]+$/.test(lines[i])) { name = lines[i + 1]; break; }
        }

        return {
          id: pick(/応募ID[\s　]*[：:]\s*(\d+)/),
          name: name,
          companyName: dodaCompanyName(),
          jobTitle: pick(/求人名称[\s　]*[：:]\s*(.+)/),
          agentRaw: pick(/応募経路[\s　]*[：:]\s*(.+)/),
          applyDate: pick(/応募日[\s　]*[：:]\s*([\d\/]+)/),
          textPdf: {
            fileName: '推薦コメント_' + (name || '応募者') + '.pdf',
            text: dodaRecommendText()
          }
        };
      },

      fetchFiles: function () {
        // 応募書類（FileDownload）とHRアナリスト分析結果（PDFDownload）の両方を拾う
        var links = [].slice.call(document.querySelectorAll('a[href]'))
          .map(function (a) { return a.href; })
          .filter(function (h) {
            return /ApplicantManagement\/[^/?]*(FileDownload|PDFDownload)/i.test(h);
          })
          .filter(function (h, i, arr) { return arr.indexOf(h) === i; });

        if (!links.length) throw new Error('応募書類のリンクが見つかりませんでした。');

        return Promise.all(links.map(function (href) {
          return fetch(href, { credentials: 'include' }).then(function (r) {
            if (!r.ok) throw new Error('書類を取得できませんでした（' + r.status + '）');
            var fallback = decodeURIComponent(String(href).split('?')[0].split('/').pop() || '推薦書類.pdf');
            var name = fileNameFrom(r, fallback);
            return r.blob().then(function (b) {
              if (!b.size) throw new Error('書類が空でした。');
              return blobToBase64(b).then(function (b64) { return { base64: b64, fileName: name }; });
            });
          });
        }));
      }
    },

    // ---------- エンエージェント Hirehub ----------
    // 候補者詳細（/candidates/{id}）で使う。添付一式をZIPで取得する
    hirehub: {
      manual: true,
      buttonText: 'この候補者をDriveへ保存',
      idle: '候補者の詳細画面を開いてから押してください。',

      collect: function () {
        var m = location.pathname.match(/\/candidates\/(\d+)/);
        var id = m ? m[1] : '';

        var lines = textLines(document.body);
        var name = '', job = '', agent = '';

        for (var i = 0; i < lines.length; i++) {
          // 「34歳 / 男性 / ID:0001690559」の1行前が氏名、1行後が求人名
          if (/^\d+歳\s*\/\s*(男性|女性)\s*\/\s*ID:\d+/.test(lines[i])) {
            name = lines[i - 1] || '';
            job = lines[i + 1] || '';
            break;
          }
        }
        for (var j = 0; j < lines.length; j++) {
          var a = lines[j].match(/^エージェント[：:]\s*(.+)$/);
          if (a) { agent = a[1].trim(); break; }
        }

        // 画面のどこかに「2026/08/07 15:31」の形で日付が出ていれば拾う
        var applyDate = '';
        var d = document.body.innerText.match(/(20\d{2})\/(\d{1,2})\/(\d{1,2})/);
        if (d) applyDate = d[1] + '/' + d[2] + '/' + d[3];

        return {
          id: id, name: name, jobTitle: job,
          agentRaw: agent || 'エン エージェント',
          applyDate: applyDate
        };
      },

      fetchFiles: function (info) {
        var url = '/candidates/download_all_attachment/' + info.id
                + '?filename=' + encodeURIComponent(info.name);

        return fetch(url, { credentials: 'include' }).then(function (r) {
          if (!r.ok) throw new Error('添付を取得できませんでした（' + r.status + '）');
          var name = fileNameFrom(r, info.name + '.zip');
          return r.blob().then(function (b) {
            if (!b.size) throw new Error('添付が登録されていないようです。');
            return blobToBase64(b).then(function (b64) { return [{ base64: b64, fileName: name }]; });
          });
        });
      }
    },

    // ---------- CIRCUS AGENT ----------
    // 履歴書・職務経歴書はボタン押下でブラウザ内にPDFが作られる作りのため、
    // ボタンを押した瞬間のPDFを受け取って保存する。画面の推薦文はGAS側でPDFにする。
    circus: {
      manual: true,
      buttonText: 'この候補者をDriveへ保存',
      idle: '職種を選んでから押してください。',
      jobs: ['営業', 'CS', '営業・CS', 'エンジニア'],

      collect: function () {
        var m = location.pathname.match(/\/selections\/(\d+)/);
        var pairs = circusFieldPairs();

        // 求職者名は「木村祐介 (27歳)」の形。カッコ以降を落とす
        var name = circusValue(pairs, '求職者名').replace(/[（(].*$/, '').trim();
        if (!name) {
          var lines = textLines(document.body);
          var i = lines.indexOf('求職者名');
          if (i >= 0 && lines[i + 1]) name = lines[i + 1].replace(/[（(].*$/, '').trim();
        }
        if (!name) {
          var f = document.body.innerText.match(/履歴書[_＿]([^\s.]+)\.pdf/);
          if (f) name = f[1];
        }

        var rec = circusRecommendText();

        // 求人名は「求人情報」タブにあるため、いったん切り替えて読み取り、元のタブへ戻す
        return circusJobTitle().then(function (job) {
          var text = circusProfileText(pairs, rec, m ? m[1] : '', job);
          return {
            id: m ? m[1] : '',
            name: name,
            jobTitle: job,
            agentRaw: 'CIRCUS',
            sourceAgent: circusSourceAgent(pairs),
            applyDate: '',
            textPdf: { fileName: '候補者情報_' + (name || '候補者') + '.pdf', text: text }
          };
        });
      },

      fetchFiles: function () {
        // CIRCUS側のボタンの文言は「ダウンロードする」から「ダウンロード」に変わったことがある。
        // どちらの書き方でも拾えるようにしておく
        var btns = [].slice.call(document.querySelectorAll('button')).filter(function (b) {
          return /^\s*ダウンロード(する)?\s*$/.test(b.innerText || '');
        });
        if (!btns.length) throw new Error('ダウンロードするボタンが見つかりませんでした。');

        // ファイル名はボタンの親ではなく、もう少し上の要素に入っている。
        // 「履歴書_山田 太郎 .pdf」のように途中に空白が入る形もあるため、行ごと拾って前後を落とす
        var names = btns.map(function (b) {
          var el = b.parentElement;
          for (var lv = 0; el && lv < 5; lv++) {
            var lines = String(el.innerText || '').split('\n');
            for (var i = 0; i < lines.length; i++) {
              var m = lines[i].match(/^\s*(.+\.(?:pdf|docx?|xlsx?))\s*$/i);
              if (m) return m[1].replace(/\s+\./, '.').trim();
            }
            el = el.parentElement;
          }
          return '';
        });

        var captured = [];
        var orig = URL.createObjectURL;
        URL.createObjectURL = function (b) {
          try {
            if (b && /pdf|octet|word|sheet|zip/i.test(String(b.type || ''))) captured.push(b);
          } catch (e) {}
          return orig.apply(this, arguments);
        };

        // ボタンを押すとブラウザのダウンロードも走り、ダウンロードフォルダに同じPDFがたまる。
        // Driveに残せば足りるため、取り込んでいる間だけダウンロードを止める。
        // 保存するPDFの中身はここで受け取ったものを使うので、止めても抜けはない
        function isDownloadLink(a) {
          if (!a || a.tagName !== 'A') return false;
          return a.hasAttribute('download') ||
                 /^blob:/.test(String(a.getAttribute('href') || ''));
        }

        var blockClick = function (e) {
          var a = e.target && e.target.closest ? e.target.closest('a') : null;
          if (isDownloadLink(a)) { e.preventDefault(); e.stopPropagation(); }
        };
        document.addEventListener('click', blockClick, true);

        var origAnchorClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
          if (isDownloadLink(this)) return;
          return origAnchorClick.apply(this, arguments);
        };

        function restore() {
          URL.createObjectURL = orig;
          HTMLAnchorElement.prototype.click = origAnchorClick;
          document.removeEventListener('click', blockClick, true);
        }

        var chain = Promise.resolve();
        btns.forEach(function (b) {
          chain = chain.then(function () { b.click(); return wait(1500); });
        });

        return chain.then(function () { return wait(1500); }).then(function () {
          restore();
          if (!captured.length) throw new Error('書類を受け取れませんでした。もう一度お試しください。');

          return Promise.all(captured.map(function (b, i) {
            return blobToBase64(b).then(function (b64) {
              return { base64: b64, fileName: names[i] || ('書類' + (i + 1) + '.pdf') };
            });
          }));
        }).catch(function (err) {
          restore();
          throw err;
        });
      }
    }
  };

  /**
   * dodaの応募者情報画面から推薦コメントを取り出す。
   * 添付ファイル名の行は除き、選考ステータスの操作欄に入る前で打ち切る。
   */
  function dodaRecommendText() {
    var lines = textLines(document.body);

    var start = -1;
    for (var i = 0; i < lines.length; i++) {
      if (/^【?推薦コメント】?/.test(lines[i])) { start = i; break; }
    }
    if (start < 0) return '';

    var stop = ['ファイルを追加', '現在の選考ステータス', '次の選考ステータス',
                'ステータスを選択', '日程を調整', '現場評価を依頼'];
    var out = [];

    for (var n = start; n < lines.length; n++) {
      if (stop.indexOf(lines[n]) >= 0) break;
      if (/\.(pdf|docx?|xlsx?|zip)$/i.test(lines[n])) continue;
      if (/^未読/.test(lines[n])) continue;
      out.push(lines[n]);
    }
    return out.join('\n');
  }

  /** CIRCUSのタブを名前で探して押す */
  function circusClickTab(label) {
    var el = [].slice.call(document.querySelectorAll('button,[role="tab"]'))
      .filter(function (e) { return (e.textContent || '').trim() === label; })
      .pop();
    if (el) { el.click(); return true; }
    return false;
  }

  /**
   * 求人情報タブへ切り替えて求人名を読み取り、候補者情報タブへ戻す。
   * 「求人票を出力する」より後ろにある最初の長い行を求人名とみなしている。
   */
  function circusJobTitle() {
    if (!circusClickTab('求人情報')) return Promise.resolve('');

    return wait(900).then(function () {
      var lines = textLines(document.body);
      var i = lines.indexOf('求人票を出力する');
      var job = '';

      if (i >= 0) {
        for (var n = i + 1; n < Math.min(i + 8, lines.length); n++) {
          if (lines[n].length > 12) { job = lines[n]; break; }
        }
      }
      circusClickTab('候補者情報');
      return wait(500).then(function () { return job; });
    });
  }

  // CIRCUSの候補者情報で、Driveには残さない項目
  var CIRCUS_SKIP = ['電話番号', 'メールアドレス', '履歴書', '職務経歴書'];
  var CIRCUS_AGENT_LABELS = ['エージェント社名', 'メイン担当者名', 'サブ担当者名'];

  /**
   * CIRCUSの候補者情報タブから「項目→値」を順番のまま取り出す。
   * 画面は左右の2列（xs-3 が項目名、xs-9 が値）なので、その組みを拾っている。
   */
  function circusFieldPairs() {
    var out = [];
    var seen = {};

    [].slice.call(document.querySelectorAll('div[class*="MuiGrid-container"]')).forEach(function (row) {
      var l = row.querySelector(':scope > div[class*="MuiGrid-grid-xs-3"]');
      var v = row.querySelector(':scope > div[class*="MuiGrid-grid-xs-9"]');
      if (!l || !v) return;

      var label = (l.innerText || '').trim();
      if (!label || seen[label]) return;
      seen[label] = true;

      var value = (v.innerText || '').split('\n')
        .map(function (x) { return x.trim(); })
        .filter(Boolean)
        .join(' / ');

      out.push([label, value]);
    });

    return out;
  }

  function circusValue(pairs, label) {
    for (var i = 0; i < pairs.length; i++) if (pairs[i][0] === label) return pairs[i][1];
    return '';
  }

  /** 台帳の備考列に残す紹介元。例 ネクストレルム株式会社（近藤隆司） */
  function circusSourceAgent(pairs) {
    var company = circusValue(pairs, 'エージェント社名');
    var person = circusValue(pairs, 'メイン担当者名');
    if (!company) return '';
    return company + (person && person !== '-' ? '（' + person + '）' : '');
  }

  /**
   * 画面の候補者情報をPDF用のテキストにまとめる。
   * 電話番号とメールアドレスは入れない。
   */
  function circusProfileText(pairs, rec, selectionId, jobTitle) {
    var basic = [], question = '', agent = [];

    pairs.forEach(function (p) {
      if (CIRCUS_SKIP.indexOf(p[0]) >= 0) return;
      if (p[0] === '質問回答') { question = p[1]; return; }
      var line = p[0] + '：' + (p[1] || '-');
      if (CIRCUS_AGENT_LABELS.indexOf(p[0]) >= 0) agent.push(line);
      else basic.push(line);
    });

    var d = new Date();
    var stamp = d.getFullYear() + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + '/' + ('0' + d.getDate()).slice(-2);

    var out = [];
    out.push('【選考情報】');
    out.push('媒体：CIRCUS');
    if (selectionId) out.push('選考ID：' + selectionId);
    if (jobTitle) out.push('求人名：' + jobTitle);
    out.push('取得日：' + stamp);

    if (basic.length) { out.push(''); out.push('【基本情報】'); out.push(basic.join('\n')); }
    if (question) { out.push(''); out.push('【質問回答】'); out.push(question); }
    if (rec) { out.push(''); out.push('【推薦文】'); out.push(rec); }
    if (agent.length) { out.push(''); out.push('【担当エージェント】'); out.push(agent.join('\n')); }

    return out.join('\n');
  }

  /** CIRCUSの画面から推薦文のかたまりを取り出す */
  function circusRecommendText() {
    // 見出し「推薦文」を包むかたまりごと読む。担当エージェント以降は別のかたまりなので混ざらない
    var head = [].slice.call(document.querySelectorAll('span,p,h1,h2,h3,h4'))
      .filter(function (e) { return !e.children.length && (e.textContent || '').trim() === '推薦文'; })
      .pop();

    if (head && head.parentElement) {
      var t = (head.parentElement.innerText || '').split('\n');
      if (t.length && t[0].trim() === '推薦文') t.shift();
      var body = t.join('\n').trim();
      if (body) return body;
    }

    // 画面の作りが変わったときの保険
    var lines = textLines(document.body);
    var i = lines.indexOf('推薦文');
    if (i < 0) return '';

    var stop = ['担当エージェント', '書類選考通過にする', '不採用にする', '送信する', 'メッセージ', 'テンプレート', '選考メモ'];
    var out = [];
    for (var n = i + 1; n < lines.length; n++) {
      if (stop.indexOf(lines[n]) >= 0) break;
      out.push(lines[n]);
    }
    return out.join('\n');
  }

  var AD = ADAPTERS[SITE];

  // ===== 保存の実行 =====

  function runSave(info) {
    if (!gasToken()) {
      var t = prompt('GASのトークンが未設定です。入力してください（最初の1回だけ）');
      if (!t) { setStatus('トークンが未設定のため保存を中止しました。', '#c00'); return; }
      GM_setValue('gas_token', t.trim());
    }
    // dodaはクライアントごとにアカウントが別なので、台帳の対象企業でログインしているときだけ進める
    if (SITE === 'doda' && !dodaCompanyOk()) {
      setStatus('ログイン中のアカウントが台帳の対象と違います（'
        + (dodaCompanyName() || '社名を読み取れません') + '）。保存を中止しました。', '#c00');
      return;
    }
    if (!info || !info.id) { setStatus('対象を特定できませんでした。', '#c00'); return; }
    if (!info.name) { setStatus('氏名を読み取れませんでした。', '#c00'); return; }

    // Greenは応募のきっかけまで台帳に残すため、未選択では進めない
    var route = selectedRoute();
    if (SITE === 'green' && !route) {
      setStatus('応募のきっかけを選んでから押してください。', '#c00');
      return;
    }

    setStatus(info.name + (route ? '（' + route + '）' : '') + ' の書類を取得しています…');

    return Promise.resolve()
      .then(function () { return AD.fetchFiles(info); })
      .then(function (files) {
        setStatus('Driveへ保存しています…（' + files.length + '件）');
        return postToGas({
          token: gasToken(),
          source: SITE,
          applyId: info.id,
          name: info.name,
          jobTitle: info.jobTitle,
          agentRaw: info.agentRaw,
          applyDate: info.applyDate,
          companyName: info.companyName || (SITE === 'doda' ? dodaCompanyName() : ''),
          jobOverride: selectedJob(),
          route: route,
          textPdf: info.textPdf || null,
          files: files
        });
      })
      .then(function (res) {
        if (res.ok) {
          var label = (res.merged ? '合算しました　' : '完了　') + res.folderName
            + (res.files && res.files.length ? '（' + res.files.join(' / ') + '）' : '');
          setStatus(label, res.merged ? '#0a7' : '#0a0',
                    res.parentUrl || res.folderUrl,
                    res.parentUrl ? res.folderUrl : null);
        } else if (res.duplicate) {
          setStatus(res.message, '#c80');
        } else {
          setStatus(res.message || '保存できませんでした。', '#c00');
        }
      })
      .catch(function (err) { setStatus(String(err.message || err), '#c00'); });
  }

  function selectedJob() {
    var sel = document.getElementById(PANEL_ID + '-job');
    return sel ? sel.value : '';
  }

  /** Greenの応募のきっかけ。他の媒体では常に空文字 */
  function selectedRoute() {
    if (SITE !== 'green') return '';
    var el = document.querySelector('input[name="' + PANEL_ID + '-route"]:checked');
    return el ? el.value : '';
  }

  function onClick() {
    var btn = document.getElementById(PANEL_ID + '-btn');
    if (btn) btn.disabled = true;
    Promise.resolve()
      .then(function () { return AD.collect(); })
      .then(function (info) { return runSave(info); })
      .catch(function (err) { setStatus(String(err.message || err), '#c00'); })
      .then(function () { if (btn) btn.disabled = false; });
  }

  // ===== パネル =====

  function loadState() {
    try {
      var s = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      return {
        left: typeof s.left === 'number' ? s.left : null,
        top: typeof s.top === 'number' ? s.top : null,
        hidden: s.hidden === true,
        route: typeof s.route === 'string' ? s.route : ''
      };
    } catch (e) { return { left: null, top: null, hidden: false, route: '' }; }
  }

  function saveState(patch) {
    var s = loadState();
    for (var k in patch) s[k] = patch[k];
    try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) {}
  }

  /**
   * url を渡すと本文がリンクになる。
   * 既定では候補者フォルダの1つ上（01_個別の一覧）へ飛ばし、
   * 候補者フォルダ自体へは小さい補助リンクを添える。
   */
  function setStatus(text, color, url, subUrl) {
    var el = document.getElementById(PANEL_ID + '-msg');
    if (!el) return;
    el.textContent = '';
    el.style.color = color || '#333';

    if (!url) { el.textContent = text; return; }

    var a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = text;
    a.title = 'Driveの一覧を開く';
    a.style.cssText = 'color:inherit;text-decoration:underline;cursor:pointer';
    el.appendChild(a);

    var hint = document.createElement('div');
    hint.textContent = '↑ 押すとDriveの一覧（01_個別）を開きます';
    hint.style.cssText = 'margin-top:4px;color:#888;font-size:11px';
    el.appendChild(hint);

    if (subUrl) {
      var b = document.createElement('a');
      b.href = subUrl;
      b.target = '_blank';
      b.rel = 'noopener';
      b.textContent = 'この方のフォルダを直接開く';
      b.style.cssText = 'display:inline-block;margin-top:2px;color:#666;font-size:11px;text-decoration:underline';
      el.appendChild(b);
    }
  }

  function setHidden(hidden) {
    var box = document.getElementById(PANEL_ID);
    var tab = document.getElementById(PANEL_ID + '-tab');
    if (!box || !tab) return;
    box.style.display = hidden ? 'none' : 'block';
    tab.style.display = hidden ? 'block' : 'none';
    saveState({ hidden: hidden });
  }

  function toggleHidden() {
    var box = document.getElementById(PANEL_ID);
    if (box) setHidden(box.style.display !== 'none');
  }

  function makeDraggable(box, handle) {
    var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;

    handle.addEventListener('mousedown', function (e) {
      dragging = true;
      var r = box.getBoundingClientRect();
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      box.style.right = 'auto';
      box.style.bottom = 'auto';
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      e.preventDefault();
    });

    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      box.style.left = Math.min(Math.max(0, ox + e.clientX - sx), window.innerWidth - box.offsetWidth) + 'px';
      box.style.top = Math.min(Math.max(0, oy + e.clientY - sy), window.innerHeight - box.offsetHeight) + 'px';
    });

    document.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      var r = box.getBoundingClientRect();
      saveState({ left: r.left, top: r.top });
    });
  }

  /**
   * いまパネルを出してよい画面かどうか。
   * CIRCUSは画面を移動してもページを読み込み直さないため、サイト全体で読み込んでおき、
   * 選考画面にいるときだけ出す。選考一覧から入ったときに出ないのを直した。
   */
  function onTargetPage() {
    if (SITE === 'circus') return /^\/selections\/\d+/.test(location.pathname);
    // リクナビは画面遷移（再読み込みなし）で候補者詳細に入ることがあるため、
    // 全ページで読み込んだうえで、候補者詳細のときだけパネルを出す
    if (SITE === 'rikunabi') return /^\/client\/candidate\/\d+/.test(location.pathname);
    return true;
  }

  function removePanel() {
    [PANEL_ID, PANEL_ID + '-tab'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
  }

  var lastPath = location.pathname;

  function mountPanel() {
    // 別の候補者へ移ったときは作り直す。前の人の結果表示が残らないようにする
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      removePanel();
    }
    if (!onTargetPage()) { removePanel(); return; }
    if (document.getElementById(PANEL_ID)) return;

    var st = loadState();

    var box = document.createElement('div');
    box.id = PANEL_ID;
    box.style.cssText = [
      'position:fixed', 'z-index:99999',
      'background:#fff', 'border:1px solid #ccc', 'border-radius:8px',
      'box-shadow:0 2px 8px rgba(0,0,0,.15)',
      'font-size:12px', 'font-family:sans-serif', 'width:300px'
    ].join(';');

    if (st.left !== null && st.top !== null) {
      box.style.left = st.left + 'px';
      box.style.top = st.top + 'px';
    } else {
      box.style.right = '16px';
      box.style.bottom = '16px';
    }

    var bar = document.createElement('div');
    bar.style.cssText = [
      'display:flex', 'align-items:center', 'justify-content:space-between',
      'cursor:move', 'user-select:none',
      'background:#f4f4f4', 'border-bottom:1px solid #e0e0e0',
      'border-radius:8px 8px 0 0', 'padding:5px 8px', 'font-weight:bold', 'color:#555'
    ].join(';');

    var title = document.createElement('span');
    var ver = '';
    try { ver = GM_info.script.version; } catch (e) {}
    title.textContent = THEME.label + (ver ? '　Ver' + ver : '');

    var close = document.createElement('span');
    close.textContent = '×';
    close.title = '隠す（option+' + THEME.key + ' で再表示）';
    close.style.cssText = 'cursor:pointer;padding:0 4px;font-size:15px;line-height:1';
    close.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    close.addEventListener('click', function () { setHidden(true); });

    bar.appendChild(title);
    bar.appendChild(close);

    var body = document.createElement('div');
    body.style.cssText = 'padding:10px 12px';

    // dodaはログイン中のアカウントを常に出し、対象外ならボタンを押せなくする。
    // 応募書類のリンクは画面を開いたあとから出てくることがあるため、
    // 一度きりの判定にせず、あとから読み直して表示とボタンを入れ替える（2026-09-24）
    var dodaNg = false;
    var accEl = null;
    if (SITE === 'doda') {
      dodaNg = !dodaCompanyOk();
      accEl = document.createElement('div');
      accEl.style.cssText = 'border-radius:4px;padding:5px 7px;margin-bottom:8px;line-height:1.5';
      body.appendChild(accEl);
      paintDodaAccount(accEl, null);
    }

    // Greenのみ、応募のきっかけを選ぶ欄を出す
    if (SITE === 'green') {
      var routeTitle = document.createElement('div');
      routeTitle.textContent = '応募のきっかけ';
      routeTitle.style.cssText = 'color:#555;margin-bottom:4px';

      var routeBox = document.createElement('div');
      routeBox.style.cssText = 'border:1px solid #e0e0e0;border-radius:4px;padding:5px 7px;margin-bottom:8px';

      ROUTES.forEach(function (r) {
        var lb = document.createElement('label');
        lb.style.cssText = 'display:block;padding:2px 0;cursor:pointer';

        var rb = document.createElement('input');
        rb.type = 'radio';
        rb.name = PANEL_ID + '-route';
        rb.value = r.value;
        rb.checked = (loadState().route === r.value);
        rb.addEventListener('change', function () { saveState({ route: r.value }); });

        lb.appendChild(rb);
        lb.appendChild(document.createTextNode(' ' + r.label));
        routeBox.appendChild(lb);
      });

      body.appendChild(routeTitle);
      body.appendChild(routeBox);
    }

    if (AD.manual) {
      var btn = document.createElement('button');
      btn.id = PANEL_ID + '-btn';
      btn.textContent = AD.buttonText;
      btn.style.cssText = 'cursor:pointer;padding:6px 12px;font-size:13px;border-radius:4px;color:#fff;width:100%;border:1px solid ' + THEME.color + ';background:' + THEME.color;
      if (AD.jobs && AD.jobs.length) {
        var sel = document.createElement('select');
        sel.id = PANEL_ID + '-job';
        sel.style.cssText = 'width:100%;margin-bottom:6px;padding:4px;font-size:12px';
        var opt0 = document.createElement('option');
        opt0.value = ''; opt0.textContent = '職種を選ぶ（未選択でも保存できます）';
        sel.appendChild(opt0);
        AD.jobs.forEach(function (j) {
          var o = document.createElement('option');
          o.value = j; o.textContent = j;
          sel.appendChild(o);
        });
        body.appendChild(sel);
      }

      if (SITE === 'doda') {
        paintDodaAccount(accEl, btn);
        watchDodaAccount(accEl, btn);
      } else if (dodaNg) {
        btn.disabled = true;
        btn.style.opacity = '0.45';
        btn.style.cursor = 'not-allowed';
      }

      btn.addEventListener('click', onClick);
      body.appendChild(btn);
    }

    var msg = document.createElement('div');
    msg.id = PANEL_ID + '-msg';
    msg.style.cssText = 'margin-top:' + (AD.manual ? '6px' : '0') + ';line-height:1.5;word-break:break-all';
    msg.textContent = AD.idle;

    body.appendChild(msg);

    // 設定ボタン（メニューが出ない環境でも設定できるように、パネルの中にも置く）
    var setRow = document.createElement('div');
    setRow.style.cssText = 'margin-top:8px;padding-top:6px;border-top:1px solid #eee;display:flex;gap:6px;flex-wrap:wrap';
    var mkBtn = function (label, fn) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.style.cssText = 'cursor:pointer;padding:3px 8px;font-size:11px;border:1px solid #bbb;border-radius:4px;background:#fafafa;color:#444';
      b.addEventListener('click', fn);
      return b;
    };
    setRow.appendChild(mkBtn('設定：トークン', askToken));
    if (SITE === 'doda') setRow.appendChild(mkBtn('設定：対象の社名', askCompany));
    body.appendChild(setRow);
    box.appendChild(bar);
    box.appendChild(body);
    document.body.appendChild(box);

    var tab = document.createElement('div');
    tab.id = PANEL_ID + '-tab';
    tab.textContent = THEME.key;
    tab.title = THEME.label + ' を表示';
    tab.style.cssText = [
      'position:fixed', 'right:0', 'bottom:80px', 'z-index:99999',
      'width:26px', 'height:34px', 'line-height:34px', 'text-align:center',
      'color:#fff', 'cursor:pointer', 'background:' + THEME.color,
      'border-radius:6px 0 0 6px', 'font:bold 13px sans-serif',
      'box-shadow:0 2px 6px rgba(0,0,0,.2)', 'display:none'
    ].join(';');
    tab.addEventListener('click', function () { setHidden(false); });
    document.body.appendChild(tab);

    makeDraggable(box, bar);
    setHidden(st.hidden);
  }

  document.addEventListener('keydown', function (e) {
    if (e.altKey && !e.ctrlKey && !e.metaKey &&
        String(e.key).toLowerCase() === THEME.key.toLowerCase()) toggleHidden();
  });

  mountPanel();
  setInterval(mountPanel, 2000);

})();
