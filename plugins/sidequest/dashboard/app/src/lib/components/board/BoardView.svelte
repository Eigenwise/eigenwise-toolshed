<script lang="ts">
  import type { BoardState } from '../../state/board.svelte';
  import BoardColumn from './BoardColumn.svelte';
  let { state }: { state: BoardState } = $props();
</script>

<div class="board"><BoardColumn {state} status="todo" tickets={state.columns.todo} /><BoardColumn {state} status="doing" tickets={state.columns.doing} /><BoardColumn {state} status="done" tickets={state.columns.done} /></div>