const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { OpenAI } = require('openai');
const axios = require('axios');
const nodemailer = require('nodemailer');

admin.initializeApp();
console.log('Functions module loaded v2');

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

    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    await admin.firestore().collection('email_otps').doc(email).set({
      otp,
      expiresAt: Date.now() + 10 * 60 * 1000,
      attempts: 0,
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
