import os
import base64
import json
import urllib.request
import urllib.error
import aws_encryption_sdk
from aws_encryption_sdk import CommitmentPolicy

KMS_KEY_ARN  = os.environ['KMS_KEY_ARN']
RESEND_KEY   = os.environ['RESEND_API_KEY']
FROM_ADDRESS = os.environ.get('FROM_ADDRESS', 'CricScore <noreply@randomappsstore.com>')

_sdk_client = aws_encryption_sdk.EncryptionSDKClient(
    commitment_policy=CommitmentPolicy.REQUIRE_ENCRYPT_ALLOW_DECRYPT
)

def _decrypt_code(cipher_b64: str) -> str:
    key_provider = aws_encryption_sdk.StrictAwsKmsMasterKeyProvider(
        key_ids=[KMS_KEY_ARN]
    )
    plaintext, _ = _sdk_client.decrypt(
        source=base64.b64decode(cipher_b64),
        key_provider=key_provider,
    )
    return plaintext.decode('utf-8')

def _send_email(to: str, subject: str, html: str):
    payload = json.dumps({'from': FROM_ADDRESS, 'to': [to], 'subject': subject, 'html': html}).encode()
    req = urllib.request.Request(
        'https://api.resend.com/emails',
        data=payload,
        headers={
            'Authorization': f'Bearer {RESEND_KEY}',
            'Content-Type': 'application/json',
            'User-Agent': 'python-requests/2.31.0',
        },
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            print(f'Resend response: {resp.status}')
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        raise RuntimeError(f'Resend {e.code}: {body}')

def _verify_template(code):
    return (
        'Verify your CricScore email',
        f'''<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
          <h2 style="color:#1a1a2e">Welcome to CricScore 🏏</h2>
          <p>Please verify your email address to activate your account.</p>
          <div style="background:#f4f4f8;border-radius:8px;padding:20px;text-align:center;margin:24px 0">
            <p style="margin:0;font-size:13px;color:#666">Your verification code</p>
            <p style="margin:8px 0 0;font-size:32px;font-weight:700;letter-spacing:6px;color:#1a1a2e">{code}</p>
          </div>
          <p style="font-size:13px;color:#888">Expires in 24 hours. If you didn&apos;t create a CricScore account, ignore this email.</p>
        </div>'''
    )

def _reset_template(code):
    return (
        'Reset your CricScore password',
        f'''<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
          <h2 style="color:#1a1a2e">Reset your password 🏏</h2>
          <p>We received a request to reset your CricScore password.</p>
          <div style="background:#f4f4f8;border-radius:8px;padding:20px;text-align:center;margin:24px 0">
            <p style="margin:0;font-size:13px;color:#666">Your reset code</p>
            <p style="margin:8px 0 0;font-size:32px;font-weight:700;letter-spacing:6px;color:#1a1a2e">{code}</p>
          </div>
          <p style="font-size:13px;color:#888">Expires in 1 hour. If you didn&apos;t request this, ignore this email.</p>
        </div>'''
    )

def _admin_template(code):
    return (
        'Your temporary CricScore password',
        f'''<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
          <h2 style="color:#1a1a2e">Welcome to CricScore 🏏</h2>
          <p>An account has been created for you. Your temporary password is:</p>
          <div style="background:#f4f4f8;border-radius:8px;padding:20px;text-align:center;margin:24px 0">
            <p style="margin:8px 0 0;font-size:24px;font-weight:700;letter-spacing:4px;color:#1a1a2e">{code}</p>
          </div>
          <p style="font-size:13px;color:#888">Sign in and change your password immediately.</p>
        </div>'''
    )

VERIFY_TRIGGERS = {
    'CustomEmailSender_SignUp',
    'CustomEmailSender_ResendCode',
    'CustomEmailSender_UpdateUserAttribute',
    'CustomEmailSender_VerifyUserAttribute',
}

def handler(event, context):
    trigger = event.get('triggerSource', '')
    print(f'Trigger: {trigger}')

    email    = (event.get('request') or {}).get('userAttributes', {}).get('email')
    raw_code = (event.get('request') or {}).get('code')

    if not email or not raw_code:
        print('Missing email or code — skipping')
        return

    code = _decrypt_code(raw_code)

    if trigger in VERIFY_TRIGGERS:
        subject, html = _verify_template(code)
    elif trigger == 'CustomEmailSender_ForgotPassword':
        subject, html = _reset_template(code)
    elif trigger == 'CustomEmailSender_AdminCreateUser':
        subject, html = _admin_template(code)
    else:
        print(f'Unhandled trigger: {trigger}')
        return

    _send_email(email, subject, html)
    print(f'✅ Sent to {email} [{trigger}]')
