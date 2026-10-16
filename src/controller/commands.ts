export interface BotCommand {
  readonly command: string;
  readonly description: string;
}

export const GENERAL_COMMANDS = [
  'start',
  'help',
  'new',
  'sessions',
  'use',
  'queue',
  'steer',
  'status',
  'cancel',
] as const;
export const OWNER_COMMANDS = ['allow', 'revoke', 'guests', 'invite'] as const;

const DESCRIPTIONS: Readonly<Record<string, string>> = {
  start: 'Start or redeem an invite',
  help: 'Show help',
  new: 'Create a session',
  sessions: 'List your sessions',
  use: 'Select a session',
  queue: 'Create a job',
  steer: 'Add input to a job',
  status: 'Show job status',
  cancel: 'Cancel a job',
  allow: 'Grant trial access',
  revoke: 'Revoke trial access',
  guests: 'List trial users',
  invite: 'Create a trial invite',
};
const command = (name: string): BotCommand => ({
  command: name,
  description: DESCRIPTIONS[name] ?? name,
});
export const OWNER_BOT_COMMANDS = [...GENERAL_COMMANDS, ...OWNER_COMMANDS].map(
  command,
);
export const GUEST_BOT_COMMANDS = [...GENERAL_COMMANDS].map(command);
export const DEFAULT_BOT_COMMANDS = ['start', 'help'].map(command);

export function parseDuration(value: string): number | null {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (match === null || match[0] !== value) return null;
  const amount = Number(match[1]);
  const unit =
    match[2] === 's'
      ? 1000
      : match[2] === 'm'
        ? 60_000
        : match[2] === 'h'
          ? 3_600_000
          : 86_400_000;
  const result = amount * unit;
  return Number.isSafeInteger(amount) &&
    amount > 0 &&
    Number.isSafeInteger(result) &&
    result <= 2_147_483_647
    ? result
    : null;
}
