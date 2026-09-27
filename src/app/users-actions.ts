'use server';

import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { requireCompany } from '@/lib/queries';
import { currentUser, requireActor } from '@/lib/session';
import { sessionCookieName } from '@/domain/auth/constants';
import type { ActionResult } from './settings-actions';
import {
  inviteUser, removeUser, changeUserRole, resetUserPassword, changeOwnPassword,
} from '@/domain/auth/users';
import type { Role } from '@/domain/auth/permissions';

/**
 * User administration and self-service actions (issues #472, #473).
 *
 * Every administration action is gated by `users.manage` — the matrix's
 * owner-only action — and delegates to the same domain functions the CLI uses,
 * so the guards and the audit trail cannot differ between surfaces.
 *
 * `changeOwnPasswordAction` is the one self-service exception: a user who is
 * still on their inviter's one-time password cannot pass `requireActor` (every
 * mutating action refuses them), yet clearing that password is exactly what
 * they must be able to do. It verifies the session itself and acts only as the
 * signed-in user.
 */

const text = (formData: FormData, key: string): string => String(formData.get(key) ?? '').trim();

function fail(error: unknown): ActionResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

export async function inviteUserAction(formData: FormData): Promise<ActionResult> {
  try {
    const actor = await requireActor('users.manage');
    const company = requireCompany();
    const username = text(formData, 'username');
    const displayName = text(formData, 'displayName');
    const role = text(formData, 'role') as Role;
    if (!username) return { ok: false, error: 'Choose a username.' };
    if (!role) return { ok: false, error: 'Choose a role.' };

    const invited = inviteUser(getDb(), {
      companyId: company.id, actorId: actor.id,
      username, displayName: displayName || undefined, role,
    });
    revalidatePath('/settings/users');
    return {
      ok: true,
      message: `Invited ${invited.username} as ${invited.role}. One-time password: ${invited.oneTimePassword}. `
        + 'Give it to the person directly — they must change it at first login, and it is never shown again.',
    };
  } catch (error) {
    return fail(error);
  }
}

export async function setUserRoleAction(formData: FormData): Promise<ActionResult> {
  try {
    const actor = await requireActor('users.manage');
    const company = requireCompany();
    changeUserRole(getDb(), {
      companyId: company.id, actorId: actor.id,
      userId: text(formData, 'userId'), role: text(formData, 'role') as Role,
    });
    revalidatePath('/settings/users');
    return { ok: true, message: 'Role changed. Their sessions ended, so the new role applies immediately.' };
  } catch (error) {
    return fail(error);
  }
}

export async function resetUserPasswordAction(formData: FormData): Promise<ActionResult> {
  try {
    const actor = await requireActor('users.manage');
    const company = requireCompany();
    const oneTimePassword = resetUserPassword(getDb(), {
      companyId: company.id, actorId: actor.id, userId: text(formData, 'userId'),
    });
    revalidatePath('/settings/users');
    return {
      ok: true,
      message: `A fresh one-time password: ${oneTimePassword}. Their old password no longer works and their `
        + 'sessions have ended. Give it to them directly; they must change it at first login.',
    };
  } catch (error) {
    return fail(error);
  }
}

export async function removeUserAction(formData: FormData): Promise<ActionResult> {
  try {
    const actor = await requireActor('users.manage');
    const company = requireCompany();
    removeUser(getDb(), {
      companyId: company.id, actorId: actor.id, userId: text(formData, 'userId'),
    });
    revalidatePath('/settings/users');
    return { ok: true, message: 'Removed. Their access ends completely: deactivated, signed out, no longer a member.' };
  } catch (error) {
    return fail(error);
  }
}

export async function changeOwnPasswordAction(formData: FormData): Promise<ActionResult> {
  try {
    // Self-service: the signed-in user acts only as themselves, so the session
    // check is `currentUser()` — `requireActor` would refuse a user still on
    // their one-time password, which is precisely who needs this screen.
    const user = await currentUser();
    if (!user) return { ok: false, error: 'Sign in again: your session has expired.' };
    const currentPassword = String(formData.get('currentPassword') ?? '');
    const newPassword = String(formData.get('newPassword') ?? '');
    const confirm = String(formData.get('confirmPassword') ?? '');
    if (newPassword !== confirm) {
      return { ok: false, error: 'The two new passwords do not match.' };
    }

    const store = await cookies();
    const token = store.get(sessionCookieName)?.value;
    changeOwnPassword(getDb(), {
      userId: user.id,
      currentPassword,
      newPassword,
      // Keep this session alive; every other session of theirs ends.
      keepSessionTokenHash: token ? createHash('sha256').update(token).digest('hex') : undefined,
    });
    revalidatePath('/settings/password');
    return { ok: true, message: 'Password changed. Your other sessions, if any, have ended.' };
  } catch (error) {
    return fail(error);
  }
}
