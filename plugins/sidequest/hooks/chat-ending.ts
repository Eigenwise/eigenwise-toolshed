// What a write tells the session to say in the chat, at the stops where the person reads and decides: the first
// message of a plan, its playback, and the commit question. Seen in real runs: the chat carried all of it while the
// pane beside it showed the same, so the person read it twice. With the board placed the chat only points at it; with
// no pane, the chat gets the whole text.
export type ChatEnding = { withBoardPlaced: string; withNoBoard: string }

export const SHOW_THE_WHOLE_TEXT = 'No board pane is placed, so show the person this text in the chat as it is:'

export const sayOnly = (lines: 'one line' | 'three lines at most'): string => `Say only this in the chat, ${lines}:`

// The reply was written for no board; once the board is placed, its ending is swapped for the pointer.
export const replyWithBoardPlaced = (reply: string, chat: ChatEnding): string =>
  reply.endsWith(chat.withNoBoard) ? `${reply.slice(0, reply.length - chat.withNoBoard.length)}${chat.withBoardPlaced}` : reply
