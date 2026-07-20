<script lang="ts">
  let { disabled = true }: { disabled?: boolean } = $props();
</script>
<section><h3>Comments</h3><textarea {disabled} placeholder="Add a comment"></textarea></section>