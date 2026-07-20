<script lang="ts">
  let { disabled = true }: { disabled?: boolean } = $props();
</script>
<section><h3>Reminder</h3><button {disabled}>Schedule reminder</button></section>