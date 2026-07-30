import { createContext } from 'svelte';
import type { BoardState } from './board.svelte';
import type { TourState } from './tour.svelte';

export const [getBoardState, setBoardState] = createContext<BoardState>();
export const [getTourState, setTourState] = createContext<TourState>();
