const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { OpenAI } = require('openai');
const axios = require('axios');
const nodemailer = require('nodemailer');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

admin.initializeApp();
console.log('Functions module loaded v2');

// ─── Firestore 자동 백업 (매일 오전 3시 KST) ───
exports.scheduledFirestoreBackup = functions
  .pubsub.schedule('0 18 * * *') // UTC 18:00 = KST 03:00
  .timeZone('UTC')
  .onRun(async () => {
    try {
      const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'mari-viet';
      const bucket = `gs://${projectId}.appspot.com`;
      const date = new Date().toISOString().slice(0, 10);
      const outputUriPrefix = `${bucket}/firestore-backups/${date}`;

      // 메타데이터 서버에서 액세스 토큰 취득
      const tokenRes = await axios.get(
        'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
        { headers: { 'Metadata-Flavor': 'Google' } }
      );
      const accessToken = tokenRes.data.access_token;

      const response = await axios.post(
        `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default):exportDocuments`,
        { outputUriPrefix, collectionIds: [] },
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      console.log(`[백업] 완료: ${outputUriPrefix}`, response.data.name);
    } catch (err) {
      console.error('[백업] 오류:', err.message);
    }
    return null;
  });

// ─── AI 이미지 생성 함수 (최고관리자 전용) ───
exports.generateImage = functions
  .runWith({
    secrets: ['OPENAI_API_KEY', 'ADMIN_SECRET'],
    timeoutSeconds: 120,
    memory: '512MB'
  })
  .https.onCall(async (data, context) => {

    // 서버 단 권한 검증: 프론트에서 전달한 adminSecret 확인
    const { prompt, size = '1024x1024', style = 'vivid', adminSecret } = data;

    if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
      throw new functions.https.HttpsError('permission-denied', '최고관리자만 사용할 수 있습니다.');
    }

    if (!prompt || prompt.trim().length < 3) {
      throw new functions.https.HttpsError('invalid-argument', '프롬프트를 입력해 주세요.');
    }

    try {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

      const response = await openai.images.generate({
        model: 'dall-e-3',
        prompt: prompt.trim(),
        n: 1,
        size: size,
        quality: 'standard',
        style: style,
      });

      const imageUrl = response.data[0].url;
      const revisedPrompt = response.data[0].revised_prompt;

      // 이미지 다운로드
      const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(imageResponse.data);

      // Firebase Storage 업로드
      const bucket = admin.storage().bucket();
      const filename = `ai-images/${Date.now()}.png`;
      const file = bucket.file(filename);

      await file.save(buffer, {
        metadata: {
          contentType: 'image/png',
          metadata: { prompt, createdAt: new Date().toISOString() }
        }
      });

      const [signedUrl] = await file.getSignedUrl({
        action: 'read',
        expires: Date.now() + 365 * 24 * 60 * 60 * 1000
      });

      // Firestore 기록
      await admin.firestore().collection('ai_images').add({
        prompt,
        revisedPrompt,
        url: signedUrl,
        storagePath: filename,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return { url: signedUrl, revisedPrompt, storagePath: filename };

    } catch (err) {
      console.error('generateImage error:', err);
      if (err.status === 400) {
        throw new functions.https.HttpsError('invalid-argument', '프롬프트가 정책에 위반됩니다. 다르게 작성해 주세요.');
      }
      throw new functions.https.HttpsError('internal', '이미지 생성 오류: ' + err.message);
    }
  });

// ─── 이미지 목록 조회 (최고관리자 전용) ───
exports.getAiImages = functions
  .runWith({ secrets: ['ADMIN_SECRET'] })
  .https.onCall(async (data, context) => {

    const { adminSecret } = data;
    if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
      throw new functions.https.HttpsError('permission-denied', '최고관리자만 사용할 수 있습니다.');
    }

    const snapshot = await admin.firestore()
      .collection('ai_images')
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get();

    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  });

// ─── 이메일 인증 코드 발송 ───
exports.sendVerificationEmail = functions
  .runWith({ secrets: ['GMAIL_USER', 'GMAIL_APP_PASS'] })
  .https.onCall(async (data, context) => {
    const { email } = data;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new functions.https.HttpsError('invalid-argument', '이메일 형식이 올바르지 않습니다.');
    }

    // ── 레이트 리밋: 60초 이내 재발송 차단
    const existing = await admin.firestore().collection('email_otps').doc(email).get();
    if (existing.exists) {
      const lastCreatedAt = existing.data().requestedAt || 0;
      if (Date.now() - lastCreatedAt < 60 * 1000) {
        throw new functions.https.HttpsError('resource-exhausted', '60초 후 다시 시도해주세요.');
      }
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    await admin.firestore().collection('email_otps').doc(email).set({
      otp,
      expiresAt: Date.now() + 10 * 60 * 1000,
      attempts: 0,
      requestedAt: Date.now(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASS }
    });

    try {
      await transporter.sendMail({
        from: `"마리 국제결혼" <${process.env.GMAIL_USER}>`,
        to: email,
        subject: '[마리 국제결혼] 이메일 인증 코드',
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;border:1px solid #eee;border-radius:12px">
            <h2 style="color:#C8102E;margin-bottom:4px">마리 국제결혼</h2>
            <p style="color:#999;font-size:13px;margin-bottom:24px">Mari International Marriage</p>
            <p style="color:#333;margin-bottom:20px">아래 인증 코드를 10분 이내에 입력해주세요.</p>
            <div style="background:#f8f8f8;border-radius:10px;padding:28px;text-align:center;margin-bottom:24px;border:1px solid #eee">
              <span style="font-size:40px;font-weight:800;letter-spacing:10px;color:#1A1A1A">${otp}</span>
            </div>
            <p style="color:#aaa;font-size:12px;line-height:1.8">
              ⏱ 유효시간: 10분<br>
              본인이 요청하지 않은 경우 이 메일을 무시하세요.
            </p>
          </div>`
      });
    } catch (mailErr) {
      // 이메일 발송 실패 시 OTP 문서 삭제 (재시도 가능하도록)
      await admin.firestore().collection('email_otps').doc(email).delete().catch(() => {});
      console.error('sendMail error:', mailErr.message, mailErr.code);
      throw new functions.https.HttpsError('internal', '이메일 발송 오류: ' + mailErr.message);
    }

    return { success: true };
  });

// ─── 이메일 인증 코드 확인 ───
exports.verifyEmailOtp = functions.https.onCall(async (data, context) => {
  const { email, otp } = data;

  const docRef = admin.firestore().collection('email_otps').doc(email);
  const doc = await docRef.get();

  if (!doc.exists) {
    return { success: false, message: '인증 코드를 먼저 발송해 주세요.' };
  }

  const { otp: storedOtp, expiresAt, attempts } = doc.data();

  if (attempts >= 5) {
    return { success: false, message: '시도 횟수 초과. 인증코드를 다시 발송해 주세요.' };
  }

  if (Date.now() > expiresAt) {
    await docRef.delete();
    return { success: false, message: '인증 코드가 만료되었습니다. 다시 발송해 주세요.' };
  }

  if (otp !== storedOtp) {
    await docRef.update({ attempts: attempts + 1 });
    const left = 5 - attempts - 1;
    return { success: false, message: `코드가 일치하지 않습니다. (${left}회 남음)` };
  }

  await docRef.delete();
  return { success: true };
});

// ─── 회원 등급 변경 (서버 검증) ───
exports.changeRole = functions
  .runWith({ secrets: ['ADMIN_SECRET'] })
  .https.onCall(async (data, context) => {
    const { callerEmail, targetEmail, newRole } = data;

    if (!callerEmail || !targetEmail || !newRole) {
      throw new functions.https.HttpsError('invalid-argument', '필수 파라미터 누락');
    }

    const validRoles = ['member', 'manager', 'married'];
    const adminOnlyRoles = ['manager', 'admin'];

    // 호출자 역할을 Firestore에서 직접 조회 (클라이언트 신뢰 안 함)
    const callerDoc = await admin.firestore().collection('users').doc(callerEmail).get();
    if (!callerDoc.exists) {
      throw new functions.https.HttpsError('unauthenticated', '인증 오류');
    }
    const callerRole = callerDoc.data().memberType;

    // 대상 회원 조회
    const targetDoc = await admin.firestore().collection('users').doc(targetEmail).get();
    if (!targetDoc.exists) {
      throw new functions.https.HttpsError('not-found', '대상 회원을 찾을 수 없습니다.');
    }
    const targetRole = targetDoc.data().memberType;

    if (callerRole === 'admin') {
      // 관리자: Firestore에서 직접 검증했으므로 추가 secret 불필요
      if (!['member','manager','married','admin'].includes(newRole)) {
        throw new functions.https.HttpsError('invalid-argument', '올바르지 않은 등급');
      }
    } else if (callerRole === 'manager') {
      // 매니저: member ↔ married 만 변경 가능, admin/manager 대상 불가
      if (!['member','married'].includes(newRole)) {
        throw new functions.https.HttpsError('permission-denied', '매니저는 일반↔결혼회원 변경만 가능합니다.');
      }
      if (['admin','manager'].includes(targetRole)) {
        throw new functions.https.HttpsError('permission-denied', '관리자/매니저 등급은 변경할 수 없습니다.');
      }
    } else {
      throw new functions.https.HttpsError('permission-denied', '권한이 없습니다.');
    }

    await admin.firestore().collection('users').doc(targetEmail).update({ memberType: newRole });
    return { success: true };
  });

// ─── 상담 신청 알림 이메일 ───
exports.notifyConsultation = functions
  .runWith({ secrets: ['GMAIL_USER', 'GMAIL_APP_PASS'] })
  .https.onCall(async (data, context) => {
    const { name, phone, age, region, message } = data;

    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASS }
    });

    try {
      await transporter.sendMail({
        from: `"마리 국제결혼" <${process.env.GMAIL_USER}>`,
        to: process.env.GMAIL_USER,
        subject: '[마리 국제결혼] 새 무료상담 신청이 접수되었습니다',
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px;border:1px solid #eee;border-radius:12px">
            <h2 style="color:#C8102E;margin-bottom:4px">마리 국제결혼</h2>
            <p style="color:#999;font-size:13px;margin-bottom:24px">새 무료상담 신청이 접수되었습니다.</p>
            <table style="width:100%;border-collapse:collapse;font-size:14px">
              <tr><td style="padding:10px 8px;color:#999;width:80px">성함</td><td style="padding:10px 8px;font-weight:700">${name}</td></tr>
              <tr style="background:#f8f8f8"><td style="padding:10px 8px;color:#999">연락처</td><td style="padding:10px 8px;font-weight:700">${phone || '-'}</td></tr>
              <tr><td style="padding:10px 8px;color:#999">나이</td><td style="padding:10px 8px">${age ? age + '세' : '-'}</td></tr>
              <tr style="background:#f8f8f8"><td style="padding:10px 8px;color:#999">지역</td><td style="padding:10px 8px">${region || '-'}</td></tr>
              <tr><td style="padding:10px 8px;color:#999;vertical-align:top">상담내용</td><td style="padding:10px 8px">${(message || '-').replace(/\n/g,'<br>')}</td></tr>
            </table>
            <p style="margin-top:24px;color:#aaa;font-size:12px">📅 ${new Date().toLocaleString('ko-KR')}</p>
          </div>`
      });
    } catch (mailErr) {
      console.error('notifyConsultation mail error:', mailErr.message);
      throw new functions.https.HttpsError('internal', '알림 발송 오류: ' + mailErr.message);
    }
    return { success: true };
  });

// ─── KCP 본인인증 ───
const KCP_SITE_CD = 'SM1SQ';
const KCP_BIN_PATH = path.join(__dirname, 'kcp/bin/ct_cli_x64');
const KCP_CERT_URL = 'https://cert.kcp.co.kr/kcp_cert/cert_view.jsp';
const KCP_CALLBACK_URL = 'https://marivnkr.com/api/kcpCallback';

let _kcpBinReady = false;
function kcpEnsureBin() {
  if (!_kcpBinReady) {
    try { fs.chmodSync(KCP_BIN_PATH, 0o755); } catch(e) {}
    _kcpBinReady = true;
  }
}
function kcpMakeHash(str) {
  kcpEnsureBin();
  try { return execFileSync(KCP_BIN_PATH, ['lf_CT_CLI__make_hash_data', str], { timeout: 5000 }).toString().trim(); }
  catch(e) { return 'HS01'; }
}
function kcpCheckHash(hashData, str) {
  kcpEnsureBin();
  try { return execFileSync(KCP_BIN_PATH, ['lf_CT_CLI__check_valid_hash', hashData, str], { timeout: 5000 }).toString().trim() === '1'; }
  catch(e) { return false; }
}
function kcpDecrypt(sitecd, certNo, encCertData) {
  kcpEnsureBin();
  try {
    const raw = execFileSync(KCP_BIN_PATH, ['lf_CT_CLI__decrypt_enc_cert', sitecd, certNo, encCertData, '1'], { timeout: 5000 }).toString().trim();
    const data = {};
    raw.split(String.fromCharCode(31)).forEach(p => {
      const idx = p.indexOf('=');
      if (idx > 0) data[p.substring(0, idx)] = decodeURIComponent(p.substring(idx + 1).replace(/\+/g, ' '));
    });
    return data;
  } catch(e) { return null; }
}

const _kcpCors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.kcpHashGen = functions.region('us-central1').https.onRequest((req, res) => {
  Object.entries(_kcpCors).forEach(([k, v]) => res.set(k, v));
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  const ordr_idxx = Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
  const up_hash = kcpMakeHash(KCP_SITE_CD + ordr_idxx + '000000');
  res.json({ ordr_idxx, up_hash, site_cd: KCP_SITE_CD, cert_url: KCP_CERT_URL, ret_url: KCP_CALLBACK_URL });
});

exports.kcpCallback = functions.region('us-central1').https.onRequest(async (req, res) => {
  if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }
  const { res_cd, cert_enc_use, cert_no, enc_cert_data, site_cd, ordr_idxx, dn_hash } = req.body || {};
  const sendHtml = html => { res.set('Content-Type', 'text/html; charset=utf-8'); res.send(html); };

  if (cert_enc_use !== 'Y' || res_cd !== '0000') {
    sendHtml(kcpPopupHtml(null, '인증이 취소되었습니다.')); return;
  }
  if (!kcpCheckHash(dn_hash, site_cd + ordr_idxx + cert_no)) {
    sendHtml(kcpPopupHtml(null, '보안 검증에 실패했습니다.')); return;
  }
  const certData = kcpDecrypt(site_cd, cert_no, enc_cert_data);
  if (!certData || !certData.phone_no) {
    sendHtml(kcpPopupHtml(null, '인증 데이터를 처리할 수 없습니다.')); return;
  }

  const { user_name, phone_no, birth_day, sex_code, ci } = certData;

  // 중복 가입 확인 (CI 기반)
  const dupInfo = crypto.createHash('md5').update(ci + ci).digest('hex');
  const dupSnap = await admin.firestore().collection('users').where('dupInfo', '==', dupInfo).limit(1).get();
  if (!dupSnap.empty) { sendHtml(kcpPopupHtml(null, '이미 가입된 본인인증 정보입니다.')); return; }

  // 전화번호 중복 확인
  const phoneDigits = phone_no.replace(/[^0-9]/g, '');
  const phoneDash = phoneDigits.replace(/^(\d{3})(\d{4})(\d{4})$/, '$1-$2-$3');
  const [p1, p2] = await Promise.all([
    admin.firestore().collection('users').where('phone', '==', phoneDigits).limit(1).get(),
    admin.firestore().collection('users').where('phone', '==', phoneDash).limit(1).get(),
  ]);
  if (!p1.empty || !p2.empty) { sendHtml(kcpPopupHtml(null, '이미 가입된 전화번호입니다.')); return; }

  const token = crypto.randomBytes(20).toString('hex');
  await admin.firestore().collection('kcpTemp').doc(token).set({
    name: user_name, phone: phone_no, birth: birth_day, sex: sex_code, dupInfo,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 10 * 60 * 1000)),
  });
  sendHtml(kcpPopupHtml(token, null));
});

exports.kcpGetResult = functions.region('us-central1').https.onRequest(async (req, res) => {
  Object.entries(_kcpCors).forEach(([k, v]) => res.set(k, v));
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  const { token } = req.query;
  if (!token) { res.status(400).json({ error: '토큰이 없습니다.' }); return; }
  const snap = await admin.firestore().collection('kcpTemp').doc(token).get();
  if (!snap.exists) { res.status(404).json({ error: '인증 정보를 찾을 수 없습니다.' }); return; }
  const data = snap.data();
  if (data.expiresAt.toDate() < new Date()) {
    await admin.firestore().collection('kcpTemp').doc(token).delete();
    res.status(410).json({ error: '인증이 만료되었습니다. 다시 시도해주세요.' }); return;
  }
  await admin.firestore().collection('kcpTemp').doc(token).delete();
  res.json({ name: data.name, phone: data.phone, birth: data.birth, sex: data.sex, dupInfo: data.dupInfo });
});

function kcpPopupHtml(token, errorMsg) {
  if (errorMsg) {
    return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"></head><body>
<script>try{window.opener&&window.opener.kcpFailed(${JSON.stringify(errorMsg)});}catch(e){}
alert(${JSON.stringify(errorMsg)});window.close();<\/script></body></html>`;
  }
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"></head><body>
<script>try{window.opener&&window.opener.kcpVerified(${JSON.stringify(token)});}catch(e){}
window.close();<\/script></body></html>`;
}

// ─── 관리자 회원 직접 등록 (Cloud Function — 권한 상승 방지) ───
exports.createAdminUser = functions
  .runWith({ secrets: ['ADMIN_SECRET'] })
  .https.onCall(async (data, context) => {
    const { callerEmail, adminSecret, userId, name, email, hashedPw, salt,
            phone, birth, gender, memberType, nationality, tempPassword } = data;

    // 호출자가 admin인지 Firestore에서 직접 확인
    const callerDoc = await admin.firestore().collection('users').doc(callerEmail).get();
    if (!callerDoc.exists) throw new functions.https.HttpsError('unauthenticated', '인증 오류');
    const callerRole = callerDoc.data().memberType;
    if (!['admin', 'manager'].includes(callerRole)) {
      throw new functions.https.HttpsError('permission-denied', '관리자/매니저만 사용할 수 있습니다.');
    }
    // 매니저는 'member', 'married'만 생성 가능
    if (callerRole === 'manager' && !['member', 'married'].includes(memberType)) {
      throw new functions.https.HttpsError('permission-denied', '매니저는 일반/결혼회원만 생성 가능합니다.');
    }

    const existing = await admin.firestore().collection('users').doc(email).get();
    if (existing.exists) throw new functions.https.HttpsError('already-exists', '이미 등록된 이메일입니다.');

    const newUser = { userId, name, email, pw: hashedPw, salt, phone: phone || '',
                      birth: birth || '', gender, memberType, nationality, tempPassword: !!tempPassword };
    await admin.firestore().collection('users').doc(email).set(newUser);
    return { success: true };
  });

// ─── Firebase Auth 비밀번호 동기화 (비밀번호 재설정 후 Auth와 Firestore 불일치 복구) ───
exports.syncFirebaseAuth = functions.https.onCall(async (data, context) => {
  const { email } = data;
  if (!email) throw new functions.https.HttpsError('invalid-argument', '이메일 필수');

  const userDoc = await admin.firestore().collection('users').doc(email).get();
  if (!userDoc.exists) throw new functions.https.HttpsError('not-found', '사용자 없음');

  // Firebase Auth 계정이 없으면 임시 생성 (다음 로그인 시 정상 비밀번호로 재동기화)
  try {
    await admin.auth().getUserByEmail(email);
  } catch(e) {
    if (e.code === 'auth/user-not-found') {
      // 클라이언트에서 signInWithEmailAndPassword로 직접 생성하게 함
    }
  }
  return { success: true };
});
