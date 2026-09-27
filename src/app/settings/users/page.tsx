import { getDb } from '@/db';
import { requireActor } from '@/lib/session';
import { listBookUsers, invitableRoles } from '@/domain/auth/users';
import { Page, Panel, Badge, Empty, Field, Input, Select } from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import { label } from '@/lib/format';
import {
  inviteUserAction, setUserRoleAction, resetUserPasswordAction, removeUserAction,
} from '@/app/users-actions';

export const dynamic = 'force-dynamic';

/**
 * The book's users (issue #473): invite, list, change role, reset a one-time
 * password, deactivate. `users.manage` is owner-only in the matrix, so every
 * other role sees the matrix's refusal rather than the people and their
 * logins.
 */
export default async function UsersPage() {
  try {
    await requireActor('users.manage');
  } catch (error) {
    return (
      <Page title="Users" subtitle="The people who may open this book, and what each may do.">
        <Panel>
          <Empty title="Not available for your role"
            detail={error instanceof Error ? error.message : 'Not allowed.'} />
        </Panel>
      </Page>
    );
  }

  const users = listBookUsers(getDb());
  const roles = invitableRoles();

  return (
    <Page
      title="Users"
      subtitle="Each person has their own login and role. The role decides what they may
        do (docs/ROLES.md); every change here is recorded in the audit trail."
    >
      <div className="grid grid-cols-2 gap-4 items-start">
        <Panel title="Invite a user">
          <div className="px-4 py-3">
            <p className="text-ink-muted mb-3 leading-relaxed">
              The person gets a one-time password they must change at first login.
              Nothing is sent anywhere — hand it to them directly.
            </p>
            <ActionForm action={inviteUserAction} submit="Invite" resetOnSuccess>
              <Field label="Username">
                <Input name="username" required placeholder="aoife" />
              </Field>
              <Field label="Display name">
                <Input name="displayName" placeholder="Aoife Ní Bhriain" />
              </Field>
              <Field label="Role" help="What the role may do is one table in the domain layer; this screen only applies it.">
                <Select name="role" required defaultValue="bookkeeper">
                  {roles.map((r) => (
                    <option key={r.role} value={r.role}>{r.label}</option>
                  ))}
                </Select>
              </Field>
            </ActionForm>
          </div>
        </Panel>

        <Panel title={`${users.length} user${users.length === 1 ? '' : 's'}`}>
          <table className="ledger">
            <thead>
              <tr>
                <th>Person</th>
                <th className="w-32">Role</th>
                <th className="w-28">State</th>
                <th className="w-64">Manage</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <span className="text-ink">{u.displayName}</span>
                    <div className="text-[11px] text-ink-faint">{u.username}</div>
                  </td>
                  <td><Badge tone="neutral">{label(u.role)}</Badge></td>
                  <td className="text-[11.5px]">
                    {u.active ? 'Active' : 'Removed'}
                    {u.mustChangePassword && <div className="text-ink-faint">One-time password</div>}
                  </td>
                  <td>
                    {u.active && (
                      <div className="space-y-2">
                        <ActionForm action={setUserRoleAction} submit="Set role" inline
                          extra={{ userId: u.id }}>
                          <Select name="role" defaultValue={u.role} className="!w-36">
                            {roles.map((r) => (
                              <option key={r.role} value={r.role}>{label(r.role)}</option>
                            ))}
                          </Select>
                        </ActionForm>
                        <div className="flex gap-2">
                          <ActionForm action={resetUserPasswordAction} submit="Reset password"
                            extra={{ userId: u.id }}
                            confirm={`Issue a fresh one-time password for ${u.username}? Their old password and sessions stop working.`} />
                          <ActionForm action={removeUserAction} submit="Remove" variant="danger"
                            extra={{ userId: u.id }}
                            confirm={`Remove ${u.username}'s access to this book? This cannot be undone from this screen.`} />
                        </div>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </Page>
  );
}
