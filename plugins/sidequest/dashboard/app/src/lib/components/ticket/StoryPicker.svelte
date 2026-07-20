<script lang="ts">
  let { disabled = true }: { disabled?: boolean } = $props();
</script>
<select {disabled} aria-label="Story"><option>Story picker</option></select>