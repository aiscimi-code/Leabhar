import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/session';
import { Page, Panel, Field, Input } from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import { changeOwnPasswordAction } from '@/app/users-actions';

export const dynamic = 'force-dynamic';

/**
 * Change your own password (issue #472).
 *
 * The one screen a user still on their inviter's one-time password must be
 * able to reach: every mutating action refuses them until the flag is
 * cleared, and this is what clears it. The action verifies the session
 * itself rather than going through `requireActor`, for exactly that reason.
 */
export default async function ChangePasswordPage() {
  const user = await currentUser();
  if (!user) redirect('/login');

  return (
    <Page
      title="Change password"
      subtitle={
        user.mustChangePassword
          ? 'You are still on the one-time password your inviter set. Choose your own password — every other action in the app refuses this state by design.'
          : 'Choose a new password. Your other sessions, if any, will end.'
      }
    >
      <Panel title="Your password">
        <div className="px-4 py-3 max-w-md">
          <ActionForm action={changeOwnPasswordAction} submit="Change password" resetOnSuccess>
            <Field label="Current password">
              <Input name="currentPassword" type="password" required autoComplete="current-password" />
            </Field>
            <Field label="New password" hint="At least 8 characters.">
              <Input name="newPassword" type="password" required autoComplete="new-password" />
            </Field>
            <Field label="New password, again">
              <Input name="confirmPassword" type="password" required autoComplete="new-password" />
            </Field>
          </ActionForm>
        </div>
      </Panel>
    </Page>
  );
}
