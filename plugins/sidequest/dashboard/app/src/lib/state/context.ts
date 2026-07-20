import { createContext } from 'svelte';
import type { BoardState } from './board.svelte';

export const [getBoardState, setBoardState] = createContext<BoardState>();
