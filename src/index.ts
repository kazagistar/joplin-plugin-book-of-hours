/*
 Copyright (c) 2023 Jakub Gedeon

 This program is free software: you can redistribute it and/or modify
 it under the terms of the GNU General Public License as published by
 the Free Software Foundation, either version 3 of the License, or
 (at your option) any later version.

 This program is distributed in the hope that it will be useful,
 but WITHOUT ANY WARRANTY; without even the implied warranty of
 MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 GNU General Public License for more details.

 You should have received a copy of the GNU General Public License
 along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import joplin from 'api';
import { Path, SettingItemType, ToolbarButtonLocation } from 'api/types';

// caches
// these are updated by the refresh function
const influences: Map<string, string> = new Map();
let influenceFolderId = null;
const tags: Map<string, string> = new Map();
let uninfluenced: Array<string> = [];

// reference to the popup window, so it can be reused
let scanningPopup = null;

// influences are prepended as links. this does the formatting
const formatInfluence = (title, id) => `[${title}](:/${id}) ⬩`;
// ... and this fishes them back out of the document so we can add more to the same line
// (also I am literally a wizard, get on my level)
const INFLUENCE_RE = /^([^]*?)((?:.*?\[.*?\]\(.*?\).*?⬩)+.*)([^]*)$/;

// if we have more then 100 influences, a simple search wont work. this is a pagination workaround for search calls
async function paginatedGet(path: Path, query?: any, page?: number): Promise<any[]> {
	query = query || {};
	page = page || 1;
	const fullQuery = {page, limit: 100, ...query};
	const result = await joplin.data.get(path, fullQuery);
	if (result.has_more) {
		return result.items.concat(await paginatedGet(path, query, page + 1));
	} else {
		return result.items;
	}
}

// when scanning starts, update the caches, in case the user moved stuff around or delete notes in the meantime
async function rescan() {
	influences.clear();
	const folderName = await joplin.settings.value("boh_folderName");
	const folderSearch = await joplin.data.get(['search'], {query: folderName, type:'folder'});
	if (folderSearch.items.length === 0) {
		console.info(`Unable to find "${folderName}" notebook, recreating`);
		const createdFolder = await joplin.data.post(['folders'], null, {title: folderName});
		influenceFolderId = createdFolder.id;
	} else {
		influenceFolderId = folderSearch.items[0].id;
	}
	const notes = await paginatedGet(['folders', influenceFolderId, 'notes'], {fields: ['title', 'id']});
	for (const influence of notes) {
		influences.set(influence.title, influence.id);
	}

	tags.clear()
	const allTags = await paginatedGet(['tags'], {fields: ['title', 'id']});
	for (let tag of allTags) {
		if (influences.has(tag.title)) {
			tags.set(tag.title, tag.id);
		}
	}

	uninfluenced = (await joplin.settings.value('boh_uninfluenced')).split(';')
}

/**
 * Gives the inner function a note based on a title, and then saves it afterwards
 *
 * State matchine progression is a bit of a clusterfuck, so hold on to your butts
 * There are 2 types of call: starting, and continuing. aka, fetching our subject, and appending to it
 * if starting, we have no note id. we need to pick the best note to start writing to, by priority
 * 	1. selected and title is the same
 *  2. title is the same
 *  3. selected and title blank
 *  4. newly created, in the same directory as selected note
 *  5. newly created, in the selected folder
 *  6. newly created wherever?
 * 	if we are continuing, its much easier. we just grab the note and go
 *
 * so the return value is either an existing item, or just a maybe parent id for where to place the item when done
 */
let activeId: string | null = null;
async function withNote(title: string, process: (note: Paste) => Promise<Paste>): Promise<void> {
	const cleanup = (input) => ({ title: input.title || '', body: input.body || '' });
	const usingExistingNote = async (input) => {
		const result = cleanup(await process(cleanup(input)));
		await joplin.data.put(['notes', activeId], null, result);
		activeId = input.id;
	}
	const usingNewNote = async (parent_id) => {
		let result = cleanup(await process({ title: '', body: ''}));
		const created = await joplin.data.post(
			['notes'],
			null,
			parent_id ? {parent_id, ...result} : result
		);
		activeId = created.id;
	}

	if (activeId) {
		let activeNote = await joplin.data.get(['notes', activeId], {fields: ['title', 'body']});
		if (activeNote) {
			return await usingExistingNote(activeNote);
		}
		// if we cant find an existing active note, start from scratch
	}

	const initialNote = await joplin.workspace.selectedNote();
	if (initialNote && initialNote.title === title) {
		await usingExistingNote(initialNote); // #1
	}
	const searchByTitle = await joplin.data.get(['search'], {
		query: title,
		type:'note',
		limit: 1,
		fields: ['title', 'body', 'id'],
	});
	if (searchByTitle.items.length > 0) {
		return await usingExistingNote(searchByTitle.items[0]); // #2
	}
	if (initialNote) {
		if (initialNote.title === '' && (!initialNote.body || initialNote.body === '')) {
			return await usingExistingNote(initialNote); // #3
		} else if (initialNote.parent_id) {
			return await usingNewNote(initialNote.parent_id); // #4
		}
	}
	const initialFolder = await joplin.workspace.selectedFolder();
	if (initialFolder) {
		return await usingNewNote(initialFolder.parent_id); // #5
	}
	return await usingNewNote(null); // #6
}

// "main" function
// first click is the card itself, the rest are influences to add as links to the card
async function linkingScan() {
	await rescan();
	// Loop repeatedly runs the scan each time the user selectes another
	while (true) {
		const result = await clipboardScan(async (raw: string) => {
			const parsed = splitRaw(raw);
			if (!parsed) { return }
			await withNote(parsed.title, async ({title, body}) => {
				// if empty, fill it out
				if (title === '') {
					title = parsed.title
					body = parsed.body;
				// if the body is already in the note, dont paste, its just a duplicate click
				} else if (body.includes(parsed.body)) {
				// if the title is the same, append
				} else if (title === parsed.title) {
					body = `${body}\n\n${parsed.body}`
				// if we have an un-influence, append
				} else if (uninfluenced.find((i: string) => i === parsed.title)) {
					body = `${body}\n\n*${parsed.title}*\n\n${parsed.body}`;
				// otherwise, its an influence that needs to be added
				} else {
					body = await addInfluence(body, parsed);
					await addTag(parsed.title)
				}
				return { title,  body };
			});
		});
		activeId = null;
		if (result !== 'yes') {
			return;
		}
	}
}

async function addTag(tag: string) {
	let tagId = tags.get(tag);
	if (!tagId) {
		const tagSearch = await joplin.data.get(['search'], {query: tag, type:'tag'});
		if (tagSearch.items.length > 0) {
			tagId = tagSearch.items[0].id;
		} else {
			const tagCreated = await joplin.data.post(["tags"], null, {title: tag});
			tagId = tagCreated.id;
		}
		tags.set(tag, tagId);
	}
	await joplin.data.post(["tags", tagId, "notes"], null, {id: activeId});
}

async function addInfluence(body: string, paste: Paste): Promise<string> {
	// add if not existing, save id
	let influenceId = influences.get(paste.title);
	if (!influenceId) {
		let result = await joplin.data.post(["notes"], null, {parent_id: influenceFolderId, ...paste});
		influenceId = result.id;
		influences.set(result.title, influenceId);
	}

	// TODO?: compare influence body and append?
	let link = `[${paste.title}](:/${influenceId}) ⬩`;
	// insert into influences
	if (body === '') {
		// add if empty
		return link;
	}
	console.info("togeather:", body);
	let separated = INFLUENCE_RE.exec(body);
	console.info("separated:", separated);
	if (!separated) {
		// prepend if no other influences found
		return link + "\n\n" + body;
	}
	let influencesLine = separated[2];
	if (influencesLine.includes(influenceId)) {
		// skip if influence already exists
		return body;
	}

	// append influence and reassemble
	return `${separated[1]}${influencesLine} ${link}${separated[3]}`
}

interface Paste {
	title: string,
	body: string
}

// afaik, all BoH clipboard text is 3 lines long:
//   a title, a blank spacer, and a body
// this functions splits it out, and ignores anything that looks "wrong" if a user forgets they had scanning on or whatever
function splitRaw(raw: string): Paste | null {
	const split = raw.split('\n');
	if (split.length < 3 || split[1] !== "") {
		console.warn("Ignoring malformed clipboard", raw);
		return null;
	}
	return {
		title: split[0],
		body: split.slice(2).join("\n"),
	};
}

// pop up dialog window
// repeatedly check clipboard for changes
// run the given function for each change
// stop when user closes the dialog
async function clipboardScan(fn: (newPaste: string) => Promise<void>): Promise<string> {
	await joplin.clipboard.writeText("");
	let killswitch = false;
	let previous = "";
	let timeout = null;
	async function checkClipboard() {
		if (killswitch) return;
		let current = await joplin.clipboard.readText();
		if (current !== previous) {
			await fn(current);
			previous = current;
		}
		setTimeout(checkClipboard, await joplin.settings.value("boh_scanDelay"));
	}
	await checkClipboard();

	let result = await joplin.views.dialogs.open(scanningPopup);
	killswitch = true;
	return result.id;
}

const linkingScanCommand = {
	name: "book-of-hours-linking-scan",
	label: "Book Of Hours Linking Scan",
	iconName: "fa fa-book",
	execute: linkingScan,
}

joplin.plugins.register({
	onStart: async function() {
		scanningPopup = await joplin.views.dialogs.create("book-of-hours-scanning-popup");
		await joplin.views.dialogs.setHtml(scanningPopup, `<h2>Click the description, then all influences</h2>`);
		await joplin.views.dialogs.setButtons(scanningPopup, [{id: 'no', title: 'Finished'}, {id: 'yes', title: 'Another'}]);
		await joplin.commands.register(linkingScanCommand);
		await joplin.views.toolbarButtons.create("boh-linking-scan", linkingScanCommand.name, ToolbarButtonLocation.NoteToolbar);
		const CONFIG_SECTION = "book_of_hours";
		await joplin.settings.registerSection(CONFIG_SECTION, {
			label: "Book Of Hours",
			iconName: 'fa fa-book',
		});
		await joplin.settings.registerSettings({
			boh_scanDelay: {
				label: "Time between clipboard checks (ms)",
				value: 50,
				type: SettingItemType.Int,
				minimum: 1,
				maximum: 2147483647,
				public: true,
				section: CONFIG_SECTION,
			},
			boh_folderName: {
				label: "Influence notebook",
				description: "Influences will automatically be generated here and linked to",
				value: "Influences",
				type: SettingItemType.String,
				public: true,
				section: CONFIG_SECTION,
			},
			boh_uninfluenced: {
				label: 'Ignored titles',
				description: "Semicolon separated titles. These aren't actually influences, and will just be copy-pasted into the document directly",
				value: "I've Read...;I'm Reading...;The Letter Reads...",
				type: SettingItemType.String,
				advanced: true,
				public: true,
				section: CONFIG_SECTION,
			},
		})
	},
});
