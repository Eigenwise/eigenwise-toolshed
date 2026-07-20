<script lang="ts">
  let { disabled = true }: { disabled?: boolean } = $props();
</script>
<input {disabled} type="file" accept="image/*" aria-label="Attachments" />