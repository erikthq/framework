import { effect, getPath, mergePatch } from 'datastar'

mergePatch({
  theme: localStorage.getItem('theme') ?? 'light dark',
})

effect(() => {
  localStorage.setItem('theme', getPath<string>('theme') ?? 'light dark')
})
