<script lang="ts">
	import { page } from '$app/state';
	import { Button } from '@evidence/core/shadcn/components/ui/button';
	import { Lock, FileQuestion, TriangleAlert } from 'lucide-svelte';

	const status = $derived(page.status);
	const message = $derived(page.error?.message || 'Something went wrong.');

	const Icon = $derived(status === 403 ? Lock : status === 404 ? FileQuestion : TriangleAlert);
	const title = $derived(
		status === 403 ? 'Access denied' : status === 404 ? 'Page not found' : `Error ${status}`
	);
</script>

<svelte:head>
	<title>Evidence - {title}</title>
</svelte:head>

<div class="flex min-h-[60vh] items-center justify-center p-4">
	<div class="flex w-full max-w-md flex-col items-center gap-4 text-center">
		<div class="bg-muted flex h-12 w-12 items-center justify-center rounded-full">
			<Icon class="text-muted-foreground h-6 w-6" />
		</div>
		<div class="space-y-1">
			<h1 class="text-foreground text-xl font-semibold">{title}</h1>
			<p class="text-muted-foreground text-sm break-words">{message}</p>
		</div>
		<Button href="/" variant="outline" size="sm">Go to home</Button>
	</div>
</div>
