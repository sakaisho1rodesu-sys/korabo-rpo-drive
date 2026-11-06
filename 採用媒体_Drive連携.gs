/**
 * 採用媒体 → Drive 連番保存　GAS側（スタンドアロン版）
 *   ユーザースクリプト saiyo_to_drive.user.js から受け取り、Driveと推薦者台帳へ書き込む
 *   対応媒体　Green（green-japan.com）
 *             リクナビHRTech（ats.hrtech.rikunabi.com）
 *             doda（assist.doda.jp）
 *             エンエージェント Hirehub（hire-hub.io）
 *             CIRCUS AGENT（circus-job.com）
 *
 * 推薦者管理.gs とは別の、独立したApps Scriptプロジェクトに置く。
 * 共有ドライブ上のスクリプトはウェブアプリのデプロイが弾かれることがあるため、
 * マイドライブ側に作ったプロジェクトから台帳とDriveへ書き込む構成にしている。
 *
 * 推薦者管理.gs 側で必要な変更
 *   AGENTS: ['エン', 'パーソル', 'リクルート', 'JAC', 'エンルーツ', 'セントラルデイリー', 'Green'],
 *   （リクナビ経由で新しいエージェント名を使う場合は、それもこの配列に足す）
 *
 * 更新履歴
 *   1.0  Green対応
 *   1.1  リクナビHRTech対応（ZIPを展開して保存）／エージェント名の変換表を追加
 *   1.2  doda対応。3媒体を1つのユーザースクリプトにまとめた
 *   1.3  添付を複数受け取れるようにした（dodaの推薦書類が複数ある場合に対応）
 *   1.4  Hirehub（エンエージェント）対応
 *   1.5  区切りのない氏名はフルネームのまま使う（姓の推測をやめた）。NAME_MODE を追加
 *   1.6  CIRCUS対応。職種の手動指定と、推薦文をPDFにして保存する機能を追加
 *   1.7  同一氏名・同一エージェントの重複推薦を1フォルダに合算し、職種を連結するようにした
 *   1.8  応答に親フォルダ（01_個別）のURLを追加。完了表示から一覧へ飛べるようにした
 *   1.9  台帳の候補者氏名にも敬称（様）を付けるようにした。合算の照合は敬称を無視して行う
 *   1.10 媒体ごとに初期ステータスを変えられるようにした
 *   1.11 取り込み時の初期ステータスを全媒体「推薦受領」に統一した
 *   1.12 紹介元エージェント（sourceAgent）を受け取り、台帳の備考列に残すようにした。
 *        画面テキストのPDF名の既定を「候補者情報_」に変えた
 *   1.13 媒体ごとの許可アカウント（ALLOWED_COMPANY）を追加。
 *        dodaはログイン中の企業名が一致しない限りDriveにも台帳にも書かない
 *   1.14 ファイル名と見出しをユーザースクリプトとそろえた
 *        （旧 Green_Drive連携_standalone.gs → 採用媒体_Drive連携.gs）
 *   1.15 dodaの応募通知メールを見張って、まだ取り込んでいない方をSlackへ流す機能を追加
 *        （watchDodaMails。ログインは不要。取り込み自体は今までどおり画面のボタンで行う）
 *   1.16 職種判定を修正。求人名の頭（【】の前／◆の前）の職種名を優先して判定する。
 *        「ソリューション営業…IoT×SaaS」が、本文中のIoTでエンジニアになっていた不具合を直した
 */

var GREEN = {
  // 台帳スプレッドシートのID
  SPREADSHEET_ID: 'YOUR_SPREADSHEET_ID',
  SHEET_NAME: '推薦者台帳',

  // 候補者フォルダを作る親フォルダ（01_個別）
  DRIVE_ROOT_ID: 'YOUR_DRIVE_ROOT_ID',

  // 取り込み時の初期ステータス。
  // どの媒体も、書類選考を依頼する前の状態として「推薦受領」で登録する。
  // 書類選考中へは、メニュー「書類選考をSlackへ依頼」を実行したときに進む
  DEFAULT_STATUS: '推薦受領',

  // 媒体ごとに初期ステータスを変えたいときだけ、ここに書く
  //   例  { doda: '書類選考中' }
  //   キーに使えるのは green / rikunabi / doda / hirehub / circus
  STATUS_BY_SOURCE: {},

  // 媒体ごとの許可アカウント。
  // dodaは1つの管理画面でクライアントを切り替えるため、
  // 送られてきた companyName がここの社名と一致しない限り保存しない。
  // 空の配列にするとその媒体の照合をしない
  ALLOWED_COMPANY: {
    doda: ['（対象のdoda社名）']
  },

  HONORIFIC: '様',

  // テスト用に使う番号帯。この番号以上は採番の対象から外す
  TEST_NO_MIN: 900,

  // 応募求人名から職種を判定する
  JOB_RULES: [
    { job: 'エンジニア', keywords: ['エンジニア', 'IOT', 'IoT', '開発', 'SE'] },
    { job: 'CS',        keywords: ['カスタマーサクセス', 'カスタマーサポート', 'CS'] },
    { job: '営業',      keywords: ['営業', 'セールス'] }
  ],

  // 台帳のプルダウンに入っている職種名。完全一致したらそのまま使う
  JOBS: ['営業', 'CS', '営業・CS', 'エンジニア'],

  // リクナビHRTech／dodaの「応募経路」から台帳のエージェント名へ変換する表
  // 左は部分一致。上から順に見て最初に当たったものを使う
  AGENT_MAP: [
    { match: 'インディードリクルートパートナーズ', label: 'リクルート' },
    { match: 'リクルートダイレクトスカウト',       label: 'リクルート' },
    { match: 'リクルート',                         label: 'リクルート' },
    { match: 'パーソル',                           label: 'パーソル' },
    { match: 'doda',                               label: 'パーソル' },
    { match: 'パーソルキャリア',                   label: 'パーソル' },
    { match: 'エン・ジャパン',                     label: 'エン' },
    { match: 'エンジャパン',                       label: 'エン' },
    { match: 'JAC',                                label: 'JAC' },
    { match: 'エンルーツ',                         label: 'エンルーツ' },
    { match: 'エン エージェント',                  label: 'エン' },
    { match: 'エンエージェント',                   label: 'エン' },
    { match: 'エン',                               label: 'エン' },
    { match: 'セントラル',                         label: 'セントラルデイリー' },
    { match: 'CIRCUS',                             label: 'CIRCUS' }
  ],

  // 変換表に当てはまらなかったときの既定値。空にすると会社名をそのまま使う
  AGENT_FALLBACK: '',

  // 同じ方が同じエージェントから複数の職種で推薦された場合、
  // 新しいフォルダを作らず既存フォルダに合算し、職種を「営業・CS」のように連結する
  MERGE_SAME_NAME: true,

  // 合算しないステータス。選考が終わっている行は別件として新規に作る
  MERGE_SKIP_STATUSES: ['書類不採用', '1次面接不採用', '2次面接不採用', '最終不採用', '内定辞退', '辞退', '入社'],

  // 職種を連結するときの並び順
  JOB_ORDER: ['営業', 'CS', 'エンジニア'],

  // 台帳の候補者氏名にも敬称を付けるか
  //   true  「岡本様」　false  「岡本」
  HONORIFIC_IN_SHEET: true,

  // フォルダ名に入れる氏名の形
  //   'last'  姓と名の区切りがあれば姓だけ（例 本田様）。区切りがなければフルネーム
  //   'full'  常にフルネーム（例 本田哲也様）
  NAME_MODE: 'last'
};

/**
 * dodaの応募通知メールの見張り。
 *
 * パーソルキャリアから届くメールには、候補者の氏名・求人名と、
 * 応募者詳細画面の直URL（ApplicantDetail?wpd=...）が入っている。
 * これを拾って台帳と突き合わせ、まだ取り込んでいない方だけをSlackへ流す。
 *
 * 大事な前提
 *   GmailApp はこのスクリプトを動かしているGoogleアカウントのメールしか読めない。
 *   dodaのメールが届くアカウントでこのプロジェクトを開くこと。
 *   どのアカウントで動いているかは watchDodaMails の実行ログの先頭に出る。
 */
var MAILWATCH = {
  ENABLED: true,

  // 探すメールの条件（Gmailの検索式）
  QUERY: '(from:persol.co.jp OR from:doda.jp) (応募通知 OR 確認依頼 OR 新規ご紹介) newer_than:30d',

  // 一度に見るスレッド数
  MAX_THREADS: 50,

  // 本文に載っている宛先の社名が、GREEN.ALLOWED_COMPANY.doda と一致するメールだけを対象にする。
  // 他社の応募者を取り違えないための歯止め。false にすると照合しない
  CHECK_COMPANY: true,

  // Slackの見出し
  HEAD: '【dodaの新着】',

  // 前回と同じ顔ぶれなら投稿しない
  SKIP_SAME: true
};

// 推薦者台帳の列番号。推薦者管理.gs の COL と同じ並びにしてある
var GCOL = {
  ID: 1, DRIVE_NO: 2, RECEIVED: 3, AGENT: 4, NAME: 5, JOB: 6,
  STATUS: 7, SLOTS: 8, SLOTS_DATE: 9, INTERVIEWERS: 10,
  FIXED: 11, FORMAT: 12, DRIVE_URL: 13, SLACK_URL: 14, SLACK_TS: 15,
  REVIEWS: 16, NEXT_ACTION: 17, DUE: 18, UPDATED: 19, NOTE: 20, MEET_URL: 21,
  ROUND: 22, MIRROR_TS: 23
};

var GCOL_COUNT = 23;

// Greenの応募のきっかけ。ユーザースクリプトの選択肢と同じ値をここに置く
var GREEN_ROUTES = ['自主応募', '話を聞きたい', 'スカウト'];

// ===== Webアプリの受け口 =====

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);

    if (!body.token || body.token !== getGreenToken()) {
      return jsonOut({ ok: false, message: 'トークンが一致しません。' });
    }

    return jsonOut(saveApplicant(body));

  } catch (err) {
    return jsonOut({ ok: false, message: '処理中にエラーが発生しました。' + err });
  }
}

function doGet() {
  return jsonOut({ ok: true, message: '応募者連携のウェブアプリは動作しています。' });
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== 本体 =====

/**
 * @param {Object} p
 *   p.source      'green' または 'rikunabi'
 *   p.applyId     媒体側の一意なID（Greenはjob_apply_id、リクナビはcandidateId）
 *   p.name        氏名（例 本田 哲也）
 *   p.jobTitle    応募求人名。リクナビは募集ポジション（営業 など）
 *   p.agentRaw    リクナビの応募経路。Greenは空でよい
 *   p.route       Greenの応募のきっかけ（自主応募 / 話を聞きたい / スカウト）
 *   p.applyDate   応募日
 *   p.fileBase64  添付ファイル（GreenはPDF、リクナビはZIP）
 *   p.fileName    添付ファイル名
 */
function saveApplicant(p) {
  // 媒体ごとの許可アカウントの照合。
  // クライアントの取り違えをここで止める。画面側のガードをすり抜けても、ここで弾く
  var allow = (GREEN.ALLOWED_COMPANY || {})[String(p.source || '')];
  if (allow && allow.length) {
    var got = normCompanyG(p.companyName);
    if (!got) {
      return { ok: false, message: 'ログイン中の企業名が入っていません。スクリプトを最新版にしてください。' };
    }
    var okCompany = false;
    for (var ci = 0; ci < allow.length; ci++) {
      if (normCompanyG(allow[ci]) === got) { okCompany = true; break; }
    }
    if (!okCompany) {
      return { ok: false, message: '台帳の対象外のアカウントです（' + p.companyName + '）。保存しませんでした。' };
    }
  }

  var sh = SpreadsheetApp.openById(GREEN.SPREADSHEET_ID).getSheetByName(GREEN.SHEET_NAME);
  if (!sh) return { ok: false, message: '台帳シートが見つかりません。' };

  var source = p.source || (p.jobApplyId ? 'green' : '');
  var applyId = String(p.applyId || p.jobApplyId || '').replace(/[^0-9]/g, '');
  if (!applyId) return { ok: false, message: '媒体側のIDが取得できませんでした。' };

  var TAGS = {
    green: 'Green', rikunabi: 'リクナビ', doda: 'doda',
    hirehub: 'Hirehub', circus: 'CIRCUS'
  };
  var tag = TAGS[source] || 'Green';

  var dup = findSourceRow(sh, tag, applyId);
  if (dup) {
    return {
      ok: false, duplicate: true,
      message: '取り込み済みです。台帳 ' + dup.row + '行目（' + dup.name + '）'
    };
  }

  var root = DriveApp.getFolderById(GREEN.DRIVE_ROOT_ID);

  var lastName = toLastName(p.name);
  // 画面から職種を取れない媒体では、送信側で指定した値を優先する
  var job = String(p.jobOverride || '').trim() || detectJob(p.jobTitle);
  // Greenは応募のきっかけまで経由に含める（例 Green（自主応募））。
  // フォルダ名と台帳の経由が揃うため、Slackの投稿にもそのまま出る
  var route = String(p.route || '').trim();
  var agent = (source === 'green')
    ? (GREEN_ROUTES.indexOf(route) >= 0 ? 'Green（' + route + '）' : 'Green')
    : resolveAgentLabel(p.agentRaw);

  // 同一氏名・同一エージェントの行があれば、そこへ合算する
  var merge = GREEN.MERGE_SAME_NAME ? findMergeTarget(sh, lastName, agent) : null;

  // 媒体ごとの初期ステータス
  var initialStatus = (GREEN.STATUS_BY_SOURCE && GREEN.STATUS_BY_SOURCE[source]) || GREEN.DEFAULT_STATUS;

  var folderNameOwner = lastName + GREEN.HONORIFIC;
  var sheetName = GREEN.HONORIFIC_IN_SHEET ? folderNameOwner : lastName;

  var folder, folderName, no, merged = false;

  if (merge) {
    merged = true;
    no = merge.no;
    job = mergeJobs(merge.job, job);
    folder = DriveApp.getFolderById(merge.folderId);
    folderName = [no, folderNameOwner, job, agent, merge.status].join('_');
    folder.setName(folderName);
  } else {
    no = nextDriveNo(root);
    folderName = [no, folderNameOwner, job, agent, initialStatus].join('_');
    folder = root.createFolder(folderName);
  }

  var saved = [];

  // 添付は配列でも単体でも受け取れるようにしている
  var incoming = [];
  if (p.files && p.files.length) {
    incoming = p.files;
  } else if (p.fileBase64 || p.pdfBase64) {
    incoming = [{ fileName: p.fileName, base64: p.fileBase64 || p.pdfBase64 }];
  }

  incoming.forEach(function (f, idx) {
    if (!f || !f.base64) return;
    var raw = Utilities.base64Decode(f.base64);
    var fname = f.fileName || (tag + '_' + lastName + '_' + applyId + (idx ? '_' + (idx + 1) : ''));

    if (/\.zip$/i.test(fname)) {
      saved = saved.concat(saveZipContents(folder, raw, lastName, applyId));
      return;
    }
    var mime = /\.pdf$/i.test(fname) ? 'application/pdf'
             : /\.docx?$/i.test(fname) ? 'application/msword'
             : 'application/octet-stream';
    if (!/\.[a-z0-9]{2,5}$/i.test(fname)) fname += '.pdf';
    folder.createFile(Utilities.newBlob(raw, mime, fname));
    saved.push(fname);
  });

  // 画面上のテキスト（CIRCUSの推薦文など）をPDFにして保存する
  if (p.textPdf && p.textPdf.text) {
    try {
      var pdfName = p.textPdf.fileName || ('候補者情報_' + lastName + '.pdf');
      var html = '<meta charset="utf-8">'
        + '<div style="font-family:sans-serif;font-size:10.5pt;line-height:1.8;white-space:pre-wrap">'
        + escapeHtmlG(p.textPdf.text) + '</div>';
      var pdf = Utilities.newBlob(html, 'text/html', 'tmp.html')
        .getAs('application/pdf').setName(pdfName);
      folder.createFile(pdf);
      saved.push(pdfName);
    } catch (err) {
      var txtName = String(p.textPdf.fileName || '候補者情報_' + lastName + '.pdf').replace(/\.pdf$/i, '') + '.txt';
      folder.createFile(Utilities.newBlob(p.textPdf.text, 'text/plain', txtName));
      saved.push(txtName + '（PDF化できずテキストで保存）');
    }
  }

  // 合算のときは既存行を更新して終わり
  if (merged) {
    sh.getRange(merge.row, GCOL.JOB).setValue(job);
    sh.getRange(merge.row, GCOL.NAME).setValue(sheetName);
    sh.getRange(merge.row, GCOL.NOTE).setValue(
      String(sh.getRange(merge.row, GCOL.NOTE).getValue() || '')
      + ' ／ ' + tag + ':' + applyId
      + (p.jobTitle ? ' / ' + p.jobTitle : '')
      + (p.sourceAgent ? ' / 紹介元 ' + p.sourceAgent : '')
      + (p.companyName ? ' / 取得元 ' + p.companyName : '')
    );
    sh.getRange(merge.row, GCOL.UPDATED).setValue(new Date());

    return {
      ok: true,
      merged: true,
      no: no,
      folderName: folderName,
      folderUrl: folder.getUrl(),
      parentUrl: root.getUrl(),
      files: saved,
      message: '同じ方の既存フォルダに合算しました。' + folderName
    };
  }

  var row = [];
  for (var i = 0; i < GCOL_COUNT; i++) row.push('');

  var no3 = ('00' + no).slice(-3);
  row[GCOL.ID - 1]        = no3;
  row[GCOL.DRIVE_NO - 1]  = no3;
  row[GCOL.RECEIVED - 1]  = parseAnyDate(p.applyDate) || new Date();
  row[GCOL.AGENT - 1]     = agent;
  row[GCOL.NAME - 1]      = sheetName;
  row[GCOL.JOB - 1]       = job;
  row[GCOL.STATUS - 1]    = initialStatus;
  row[GCOL.DRIVE_URL - 1] = folder.getUrl();
  row[GCOL.UPDATED - 1]   = new Date();
  row[GCOL.NOTE - 1]      = tag + ':' + applyId
    + (p.applyDate ? ' 応募日 ' + p.applyDate : '')
    + (p.jobTitle ? ' / ' + p.jobTitle : '')
    + (p.agentRaw ? ' / ' + p.agentRaw : '')
    + (p.sourceAgent ? ' / 紹介元 ' + p.sourceAgent : '')
    + (p.companyName ? ' / 取得元 ' + p.companyName : '');

  sh.appendRow(row);
  sortByDriveNoStandalone(sh);

  return {
    ok: true,
    no: no,
    folderName: folderName,
    folderUrl: folder.getUrl(),
    parentUrl: root.getUrl(),
    files: saved,
    message: folderName + ' を作成しました。'
  };
}

/** ZIPを展開して中身をフォルダへ入れる。展開できなければZIPのまま保存する */
function saveZipContents(folder, raw, lastName, applyId) {
  var names = [];
  try {
    var files = Utilities.unzip(Utilities.newBlob(raw, 'application/zip', 'resume.zip'));
    if (!files.length) throw new Error('中身が空です');

    files.forEach(function (f, i) {
      var n = String(f.getName() || '').split('/').pop();
      // 文字化けや空名のときはこちらで付け直す
      if (!n || /\uFFFD/.test(n)) {
        var ext = (n.match(/\.[A-Za-z0-9]{2,5}$/) || ['.pdf'])[0];
        n = 'レジュメ_' + lastName + '_' + applyId + (i ? '_' + (i + 1) : '') + ext;
      }
      folder.createFile(f.setName(n));
      names.push(n);
    });

  } catch (err) {
    var zipName = 'レジュメ_' + lastName + '_' + applyId + '.zip';
    folder.createFile(Utilities.newBlob(raw, 'application/zip', zipName));
    names.push(zipName + '（展開できなかったためZIPのまま保存）');
  }
  return names;
}

/**
 * 同一氏名・同一エージェントで、まだ選考中の行を探す
 * 見つかれば、その行に合算する（新しいフォルダを作らない）
 */
function findMergeTarget(sh, lastName, agent) {
  var last = sh.getLastRow();
  if (last < 2) return null;

  var vals = sh.getRange(2, 1, last - 1, GCOL_COUNT).getValues();

  var key = normalizeName(lastName);

  for (var i = vals.length - 1; i >= 0; i--) {
    var r = vals[i];
    if (normalizeName(r[GCOL.NAME - 1]) !== key) continue;
    if (String(r[GCOL.AGENT - 1]).trim() !== agent) continue;

    var status = String(r[GCOL.STATUS - 1]).trim();
    if (GREEN.MERGE_SKIP_STATUSES.indexOf(status) >= 0) continue;

    var url = String(r[GCOL.DRIVE_URL - 1]);
    var m = url.match(/folders\/([A-Za-z0-9_-]+)/);
    if (!m) continue;

    return {
      row: i + 2,
      no: String(r[GCOL.DRIVE_NO - 1]).replace(/[^0-9]/g, '') || String(r[GCOL.ID - 1]),
      job: String(r[GCOL.JOB - 1]).trim(),
      status: status || GREEN.DEFAULT_STATUS,
      folderId: m[1]
    };
  }
  return null;
}

/** 敬称や空白の違いを無視して氏名を比べるための正規化 */
function normalizeName(s) {
  return String(s || '').trim().replace(/[　\s]/g, '').replace(/(様|さん|殿)$/, '');
}

/** 「営業」と「CS」→「営業・CS」。重複は取り除き、決めた順序で並べる */
function mergeJobs(a, b) {
  var set = [];
  [a, b].forEach(function (x) {
    String(x || '').split('・').forEach(function (t) {
      t = t.trim();
      if (t && set.indexOf(t) < 0) set.push(t);
    });
  });
  if (!set.length) return '';

  set.sort(function (x, y) {
    var ix = GREEN.JOB_ORDER.indexOf(x), iy = GREEN.JOB_ORDER.indexOf(y);
    return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy);
  });
  return set.join('・');
}

/** 親フォルダ内の連番の最大値 + 1 */
function nextDriveNo(root) {
  var max = 0;
  var it = root.getFolders();
  while (it.hasNext()) {
    var m = String(it.next().getName()).match(/^\s*(\d+)/);
    if (!m) continue;
    var n = parseInt(m[1], 10);
    if (n > max && n < GREEN.TEST_NO_MIN) max = n;
  }
  return max + 1;
}

/** 備考列に <媒体>:<id> がある行を探す */
function findSourceRow(sh, tag, applyId) {
  var last = sh.getLastRow();
  if (last < 2) return null;

  var notes = sh.getRange(2, GCOL.NOTE, last - 1, 1).getValues();
  var names = sh.getRange(2, GCOL.NAME, last - 1, 1).getValues();
  var re = new RegExp(tag + ':' + applyId + '(\\D|$)');

  for (var i = 0; i < notes.length; i++) {
    if (re.test(String(notes[i][0]))) return { row: i + 2, name: String(names[i][0]) };
  }
  return null;
}

function sortByDriveNoStandalone(sh) {
  var last = sh.getLastRow();
  if (last < 3) return;
  sh.getRange(2, 1, last - 1, GCOL_COUNT).sort({ column: GCOL.DRIVE_NO, ascending: true });
}

/**
 * フォルダ名と台帳に入れる氏名を決める
 *   姓と名の間に区切りがある場合　「本田 哲也」→「本田」
 *   区切りがない場合　　　　　　　「穴井丈太郎」→「穴井丈太郎」（そのまま）
 * 区切りのない氏名から姓を推測すると3文字姓や1文字姓で取り違えるため、
 * 推測はせずフルネームのまま使う。
 * GREEN.NAME_MODE を 'full' にすると、区切りがある場合も姓名をつなげて使う。
 */
function toLastName(full) {
  var s = String(full || '').trim().replace(/[　\s]+/g, ' ');
  if (!s) return '不明';

  if (GREEN.NAME_MODE === 'full') return s.replace(/ /g, '');
  if (s.indexOf(' ') >= 0) return s.split(' ')[0];
  return s;
}

/** 求人名から職種判定に使う「頭の部分」を取り出す（例「ソリューション営業【780万円〜】…」→「ソリューション営業」） */
function jobTitleHead_(t) {
  var s = String(t || '').trim();
  var m = s.match(/^([^【\[]+)[【\[]/);
  if (m && m[1].trim()) return m[1].trim();
  s = s.replace(/【[^】]*】/g, ' ').replace(/\[[^\]]*\]/g, ' ').trim();
  return s.split(/[◆◇■□●▼｜|\/／]/)[0].trim();
}

/** キーワードに当てはまった職種の一覧を返す */
function matchJobs_(text, rules) {
  var hits = [];
  rules.forEach(function (rule) {
    for (var i = 0; i < rule.keywords.length; i++) {
      var k = rule.keywords[i];
      var ok = (k === 'SE' || k === 'CS')
        ? new RegExp('(^|[^A-Za-z])' + k + '([^A-Za-z]|$)').test(text)
        : text.indexOf(k) >= 0;
      if (ok) { hits.push(rule.job); return; }
    }
  });
  return hits;
}

function pickJob_(hits) {
  if (!hits.length) return '';
  if (hits.indexOf('エンジニア') >= 0) return 'エンジニア';
  if (hits.indexOf('営業') >= 0 && hits.indexOf('CS') >= 0) return '営業・CS';
  return hits[0];
}

/** 応募求人名から職種を判定する */
function detectJob(title) {
  var t = String(title || '').trim();
  if (!t) return '';

  // リクナビの募集ポジションのように、そのまま職種名が入っている場合
  if (GREEN.JOBS.indexOf(t) >= 0) return t;

  // まず求人名の頭（職種名が書かれる場所）だけで判定する。
  // 本文の「IoT×SaaS」「開発」などの業界ワードで、営業がエンジニアになるのを防ぐ
  var head = pickJob_(matchJobs_(jobTitleHead_(t), GREEN.JOB_RULES));
  if (head) return head;

  // 頭で決まらないときは全文から。ここでは広すぎる語（IoT・開発・SE）は使わず、
  // 営業とエンジニアが両方出たときは営業を優先する
  var strong = GREEN.JOB_RULES.map(function (r) {
    return { job: r.job, keywords: r.keywords.filter(function (k) { return ['IOT', 'IoT', '開発', 'SE'].indexOf(k) < 0; }) };
  });
  var hits = matchJobs_(t, strong);
  if (hits.indexOf('営業') >= 0 && hits.indexOf('エンジニア') >= 0) hits = hits.filter(function (h) { return h !== 'エンジニア'; });
  return pickJob_(hits);
}

/** 応募経路の文字列から台帳のエージェント名を決める */
function resolveAgentLabel(raw) {
  var s = String(raw || '').trim();
  if (!s) return GREEN.AGENT_FALLBACK || '不明';

  for (var i = 0; i < GREEN.AGENT_MAP.length; i++) {
    if (s.toLowerCase().indexOf(GREEN.AGENT_MAP[i].match.toLowerCase()) >= 0) {
      return GREEN.AGENT_MAP[i].label;
    }
  }
  if (GREEN.AGENT_FALLBACK) return GREEN.AGENT_FALLBACK;

  // 会社名だけを残す。「株式会社インディード…(担当者名)」→「インディード…」
  return s.replace(/[（(].*$/, '').replace(/株式会社|有限会社|合同会社/g, '').trim() || '不明';
}

/** 社名を照合用にそろえる。全角英数を半角にし、空白を落とす */
function normCompanyG(s) {
  return String(s || '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    })
    .replace(/[\s\u3000]/g, '')
    .toLowerCase();
}

function escapeHtmlG(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function parseAnyDate(s) {
  var m = String(s || '').match(/(\d{4})[\/年.-](\d{1,2})[\/月.-](\d{1,2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// ===== トークン =====

function getGreenToken() {
  return PropertiesService.getScriptProperties().getProperty('GREEN_TOKEN') || '';
}

/** トークンを新しく作って実行ログに出す。運用開始後に実行すると差し替えになる */
function showGreenToken() {
  var token = Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('GREEN_TOKEN', token);
  Logger.log(token);
}

/** 作り直さずに現在の値だけを見る */
function printGreenToken() {
  Logger.log(getGreenToken() || '（未設定）');
}

// ===== 動作確認 =====

/** 台帳とDriveに接続できるかだけを確かめる。何も書き込まない */
function testConnection() {
  var sh = SpreadsheetApp.openById(GREEN.SPREADSHEET_ID).getSheetByName(GREEN.SHEET_NAME);
  var root = DriveApp.getFolderById(GREEN.DRIVE_ROOT_ID);
  Logger.log('台帳の行数：' + sh.getLastRow());
  Logger.log('親フォルダ：' + root.getName());
  Logger.log('次の連番：' + nextDriveNo(root));
}

/** ファイルなしでフォルダと台帳の行を作る。確認後は手で削除すること */
function testGreenImport() {
  Logger.log(JSON.stringify(saveApplicant({
    source: 'green',
    applyId: '9999999',
    name: 'テスト 太郎',
    jobTitle: 'ソリューション営業【フルリモート】製造業DXで注目のSaaSスタートアップ',
    applyDate: '2026/08/17'
  })));
}

function testRikunabiImport() {
  Logger.log(JSON.stringify(saveApplicant({
    source: 'rikunabi',
    applyId: '9999998',
    name: 'テスト 花子',
    jobTitle: '営業',
    agentRaw: '株式会社インディードリクルートパートナーズ(担当者名)',
    applyDate: '2026/08/17'
  })));
}

function testDodaImport() {
  Logger.log(JSON.stringify(saveApplicant({
    source: 'doda',
    applyId: '9999997',
    name: 'テスト 次郎',
    jobTitle: '【愛知／碧南市】IoTソリューションエンジニア◆組込みからクラウド連携まで',
    agentRaw: 'doda人材紹介',
    applyDate: '2026/08/17'
  })));
}

function testHirehubImport() {
  Logger.log(JSON.stringify(saveApplicant({
    source: 'hirehub',
    applyId: '9999996',
    name: 'テスト史郎',
    jobTitle: '製造DX×SaaS営業【営業立ち上げから携われる】',
    agentRaw: 'エン エージェント',
    applyDate: '2026/08/17'
  })));
}

function testCircusImport() {
  Logger.log(JSON.stringify(saveApplicant({
    source: 'circus',
    applyId: '9999995',
    name: '木村 祐介',
    jobOverride: '営業・CS',
    agentRaw: 'CIRCUS',
    applyDate: '2026/08/17',
    textPdf: { fileName: '推薦文_テスト.pdf', text: '推薦文のテストです。\n改行も入ります。' }
  })));
}

// ===== dodaの応募通知メールを見張る =====

/**
 * トリガーから呼ぶ本体。
 * メールを読み、台帳にまだ無い方だけをSlackへ流す。台帳にもDriveにも書き込まない。
 */
function watchDodaMails() {
  var me = '';
  try { me = Session.getActiveUser().getEmail(); } catch (e0) {}
  Logger.log('動かしているアカウント：' + (me || '（取得できません）'));

  if (!MAILWATCH.ENABLED) { Logger.log('MAILWATCH.ENABLED が false です。'); return; }

  var found = collectDodaMails_();
  Logger.log('メールから拾えた候補者：' + found.length + '件');
  if (!found.length) return;

  var idx = ledgerIndex_();
  var pending = found.filter(function (c) { return !alreadyInLedger_(idx, c); });

  Logger.log('まだ台帳に無い方：' + pending.length + '件');
  if (!pending.length) {
    writeMailWatchMark_('');
    return;
  }

  var mark = pending.map(function (c) { return c.name + '|' + (c.applyId || ''); }).sort().join(',');
  if (MAILWATCH.SKIP_SAME && mark === readMailWatchMark_()) {
    Logger.log('前回と同じ顔ぶれのため投稿しません。');
    return;
  }

  var res = slackPostStandalone_(buildMailWatchText_(pending));
  if (res) writeMailWatchMark_(mark);
}

/** 投稿せず、拾えた内容だけを実行ログに出す。設定の確認用 */
function testWatchDodaMails() {
  var me = '';
  try { me = Session.getActiveUser().getEmail(); } catch (e0) {}
  Logger.log('動かしているアカウント：' + (me || '（取得できません）'));

  var found = collectDodaMails_();
  Logger.log('メールから拾えた候補者：' + found.length + '件');
  found.forEach(function (c) {
    Logger.log('・' + c.name + '　' + (c.jobTitle || '求人名なし') +
               '　ID:' + (c.applyId || 'なし') + '　URL:' + (c.url ? 'あり' : 'なし') +
               '　' + Utilities.formatDate(c.date, 'Asia/Tokyo', 'M/d HH:mm'));
  });

  var idx = ledgerIndex_();
  var pending = found.filter(function (c) { return !alreadyInLedger_(idx, c); });
  Logger.log('--- まだ台帳に無い方 ' + pending.length + '件 ---');
  Logger.log(buildMailWatchText_(pending));
}

/** メールを読んで候補者の一覧にする。新しい順 */
function collectDodaMails_() {
  var threads = GmailApp.search(MAILWATCH.QUERY, 0, MAILWATCH.MAX_THREADS);
  var seen = {}, out = [];

  threads.forEach(function (th) {
    th.getMessages().forEach(function (msg) {
      var c = parseDodaMail_(msg);
      if (!c) return;
      var key = normalizeName(c.name) + '|' + (c.applyId || '');
      if (seen[key]) {
        // 同じ方の通知が複数回来ることがある。URLを持っている方を残す
        if (c.url && !seen[key].url) { seen[key].url = c.url; }
        if (c.jobTitle && !seen[key].jobTitle) { seen[key].jobTitle = c.jobTitle; }
        return;
      }
      seen[key] = c;
      out.push(c);
    });
  });

  out.sort(function (a, b) { return b.date.getTime() - a.date.getTime(); });
  return out;
}

/**
 * 1通のメールから 氏名・候補者ID・求人名・詳細URL を取り出す。
 * 取り出せなければ null。
 *
 * 2つの形が来る
 *   確認依頼　　[30996845]賈 鵬様　＋　応募者詳細画面のURL
 *   応募通知　　◆村瀬 徳宏様　　　（URLなし。求人名は件名のかっこの中）
 */
function parseDodaMail_(msg) {
  var body = '';
  try { body = msg.getPlainBody() || ''; } catch (e) { return null; }
  if (!body) return null;

  if (MAILWATCH.CHECK_COMPANY && !mailIsForAllowedCompany_(body)) return null;

  var subject = msg.getSubject() || '';
  var name = '', applyId = '', jobTitle = '', url = '';

  var mUrl = body.match(/https:\/\/assist\.doda\.jp\/DodaAssistR\/ApplicantManagement\/ApplicantDetail\?[^\s]+/);
  if (mUrl) url = mUrl[0];

  // 確認依頼の形
  var mCand = body.match(/\[(\d{6,})\]\s*([^\r\n\[\]]+?)\s*様/);
  if (mCand) {
    applyId = mCand[1];
    name = mCand[2].trim();
  }

  // 応募通知の形
  if (!name) {
    var mMaru = body.match(/^[◆■]\s*([^\r\n]+?)\s*様\s*$/m);
    if (mMaru) name = mMaru[1].trim();
  }
  if (!name) return null;

  // 求人名。本文の「ご推薦先求人」を優先し、無ければ件名のかっこの中
  var mJob = body.match(/ご推薦先求人[：:]\s*(?:\[\d+\])?\s*([^\r\n]+)/);
  if (mJob) jobTitle = mJob[1].trim();
  if (!jobTitle) {
    var mSub = subject.match(/[（(]([^（）()]{6,})[）)]\s*$/);
    if (mSub) jobTitle = mSub[1].trim();
  }

  return { name: name, applyId: applyId, jobTitle: jobTitle, url: url, date: msg.getDate() };
}

/** 本文の宛先社名が、許可した社名かどうか */
function mailIsForAllowedCompany_(body) {
  var allow = (GREEN.ALLOWED_COMPANY && GREEN.ALLOWED_COMPANY.doda) || [];
  if (!allow.length) return true;

  var b = normCompanyG(body);
  for (var i = 0; i < allow.length; i++) {
    if (b.indexOf(normCompanyG(allow[i])) >= 0) return true;
  }
  return false;
}

/**
 * その方がもう台帳にいるかどうか。
 * 台帳の氏名は姓だけの形（村瀬様）で入ることがあり、メールはフルネーム（村瀬 徳宏）で来る。
 * そのためフルネームと姓の両方で照らす。
 */
function alreadyInLedger_(idx, c) {
  if (c.applyId && idx.ids[c.applyId]) return true;

  var full = normalizeName(c.name);
  if (full && idx.names[full]) return true;

  var last = normalizeName(toLastName(c.name));
  if (last && idx.names[last]) return true;

  return false;
}

/** 台帳にすでに入っている氏名と、備考の doda:ID を集める */
function ledgerIndex_() {
  var out = { names: {}, ids: {} };
  try {
    var sh = SpreadsheetApp.openById(GREEN.SPREADSHEET_ID).getSheetByName(GREEN.SHEET_NAME);
    var last = sh.getLastRow();
    if (last < 2) return out;

    sh.getRange(2, GCOL.NAME, last - 1, 1).getValues().forEach(function (r) {
      var n = normalizeName(r[0]);
      if (n) out.names[n] = true;
    });

    sh.getRange(2, GCOL.NOTE, last - 1, 1).getValues().forEach(function (r) {
      var m = String(r[0] || '').match(/doda:(\d+)/g);
      if (!m) return;
      m.forEach(function (t) { out.ids[t.replace('doda:', '')] = true; });
    });
  } catch (err) {
    Logger.log('台帳を参照できません：' + err);
  }
  return out;
}

/** Slackへ流す本文 */
function buildMailWatchText_(list) {
  var lines = [MAILWATCH.HEAD + 'まだ取り込んでいない方が ' + list.length + '名います'];
  lines.push('');

  list.forEach(function (c) {
    lines.push('・' + c.name + '様　' + (c.jobTitle || '求人名なし') +
               '　（' + Utilities.formatDate(c.date, 'Asia/Tokyo', 'M月d日') + '）');
    if (c.url) lines.push('　<' + c.url + '|応募者詳細を開く>');
    else lines.push('　<https://assist.doda.jp/DodaAssistR/ApplicantManagement/ApplicantManagement|応募者管理を開く>');
  });

  lines.push('');
  lines.push('詳細画面を開いて、パネルの保存ボタンを押すとDriveと台帳に入ります。');
  lines.push('ログインが切れている場合は、その場でログインしてから開き直してください。');
  return lines.join('\n');
}

/** 直近に流した顔ぶれの控え */
function readMailWatchMark_() {
  return PropertiesService.getScriptProperties().getProperty('MAILWATCH_LAST') || '';
}
function writeMailWatchMark_(v) {
  PropertiesService.getScriptProperties().setProperty('MAILWATCH_LAST', v || '');
}

// ===== Slackへの投稿（このプロジェクト用）=====

/**
 * ボットトークンとチャンネルIDを入れる。
 * 下の2つを書き換えてから1回だけ実行し、実行後はまた空に戻しておくこと。
 */
function setMailWatchSlack() {
  var TOKEN = '';     // xoxb- で始まるボットトークン
  var CHANNEL = '';   // 投稿先チャンネルID（Cから始まる）

  var props = PropertiesService.getScriptProperties();
  if (TOKEN) props.setProperty('SLACK_TOKEN', TOKEN);
  if (CHANNEL) props.setProperty('SLACK_CHANNEL', CHANNEL);
  Logger.log('トークン：' + (props.getProperty('SLACK_TOKEN') ? '設定済み' : '未設定'));
  Logger.log('チャンネル：' + (props.getProperty('SLACK_CHANNEL') || '未設定'));
}

function slackPostStandalone_(text) {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('SLACK_TOKEN') || '';
  var channel = props.getProperty('SLACK_CHANNEL') || '';

  if (!token || !channel) {
    Logger.log('Slackの設定が未登録のため投稿しません。setMailWatchSlack を実行してください。');
    Logger.log(text);
    return false;
  }

  try {
    var res = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({ channel: channel, text: text }),
      muteHttpExceptions: true
    });
    var out = JSON.parse(res.getContentText());
    if (!out.ok) { Logger.log('Slackへの投稿に失敗：' + out.error); return false; }
    return true;
  } catch (err) {
    Logger.log('Slackへの投稿に失敗：' + err);
    return false;
  }
}

// ===== トリガー =====

/** 平日の朝9時と夕方17時に見張る。実行すると古い同名トリガーを消して入れ直す */
function setupMailWatchTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'watchDodaMails') ScriptApp.deleteTrigger(t);
  });

  [9, 17].forEach(function (h) {
    ScriptApp.newTrigger('watchDodaMails').timeBased().atHour(h).everyDays(1).create();
  });
  Logger.log('9時台と17時台の1日2回で登録しました。');
}

/** 見張りのトリガーを外す */
function removeMailWatchTrigger() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'watchDodaMails') { ScriptApp.deleteTrigger(t); n++; }
  });
  Logger.log('外したトリガー：' + n + '件');
}
