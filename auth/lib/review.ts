// Test account for app-directory reviewers (OpenAI asks for a login without MFA or a device-bound
// key). Off unless AUTH_REVIEW_PASSWORD (16+ chars) is set. The login is fixed ("reviewer") and maps
// to one fixed account, so reviewers never touch real users' data. Rate limited by the caller.
import { equal } from './crypto';
import { getUser, saveUser, type User } from './users';

export const REVIEW_LOGIN = 'reviewer';
export const REVIEW_USER_ID = 'u_app_review';
export const reviewEnabled = () => (process.env.AUTH_REVIEW_PASSWORD || '').length >= 16;

export async function reviewLogin(login: string, password: string): Promise<User> {
  const pw = process.env.AUTH_REVIEW_PASSWORD || '';
  const okLogin = equal(String(login).trim().toLowerCase(), REVIEW_LOGIN);
  const okPw = pw.length >= 16 && equal(String(password), pw);
  if (!okLogin || !okPw) throw new Error('Wrong login or password · Неверный логин или пароль');
  let u = await getUser(REVIEW_USER_ID);
  if (!u) { u = { id: REVIEW_USER_ID, name: 'App reviewer', created: Date.now(), credentials: [] }; await saveUser(u); }
  return u;
}
