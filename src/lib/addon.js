const fs = require('fs')
const needle = require('needle')
const rimraf = require('rimraf')
const async = require('async')
const path = require('path')
const os = require('os')
const addonsDir = require('./dirs/addonsDir')()
const persist = require('./persist')
const unzip = require('./unzip')
const proxy = require('./proxy')
const login = require('./login')
const bundle = require('./bundle')
const vm = require('./vm')
const children = require('./children')

const allAddons = require('../addonsList')

const userConfig = require('./config/userConfig')
const addonConfig = require('./config/addonConfig')
const defaultConfig = require('./config/defaultConfig')

const addons = {}

let sideloadedAddons = []

function parseRepo(github) {
	const parts = github.split('/')
	const user = parts[0]
	let repo
	let tree
	if (parts[1].includes('#')) {
		repo = parts[1].split('#')[0]
		tree = parts[1].split('#')[1]
	} else {
		repo = parts[1]
		tree = 'master'
	}
	return { user, repo, tree }
}

function zipBall(github) {
	return new Promise((resolve, reject) => {
		needle.get('https://api.github.com/repos/' + github + '/releases', (err, resp, body) => {
			if (body && Array.isArray(body) && body.length) {
				const tag = body[0].tag_name
				const zipBall = body[0].zipball_url
				resolve({
					tag: body[0].tag_name,
					zipBall: body[0].zipball_url
				})
			} else {
				if (err)
					console.error(err)
				reject(new Error('Could not get releases for: ' + github))
			}
		})
	})
}

const addonApi = {
	saveSettings: payload => {
		let obj

		try {
			obj = JSON.parse(payload)
		} catch(e) {
			console.error('Could not parse user settings json')
			return Promise.reject(e)
		}

		return login.hidden().then(dt => {

			const uConfig = userConfig.read().userDefined

			const hiddenPassword = dt.pass

			if (hiddenPassword && obj.password && hiddenPassword == obj.password)
				obj.password = uConfig.password

			return userConfig.writeSettings(obj)
		})
	},
	get: name => {
		return addons[name]
	},
	getManifest: name => {
		if (name == '_pimpmystremio')
			return name
		let manifest
		sideloadedAddons.concat(allAddons).some(addon => {
			if (addon.repo.endsWith('/' + name)) {
				manifest = addon
				return true
			}
		})
		return manifest
	},
	defaultConfig: data => {
		if (data == '_pimpmystremio') {
			return new Promise((resolve, reject) => {
				const uConfig = JSON.parse(JSON.stringify(userConfig.readClean().userDefined))
				login.hidden().then(dt => {
					uConfig.password.value = dt.pass
					resolve(uConfig)
				})
			})
		}
		return new Promise((resolve, reject) => {
			const name = parseRepo(data.repo).repo
			resolve(defaultConfig.get(name, data))
		})
	},
	addonConfig: async data => {
		if (data == '_pimpmystremio') {
			return new Promise((resolve, reject) => {
				const uConfig = JSON.parse(JSON.stringify(userConfig.read().userDefined))
				login.hidden().then(dt => {
					uConfig.password = dt.pass
					resolve(uConfig)
				})
			})
		}
		return new Promise(async (resolve, reject) => {
			const name = parseRepo(data.repo).repo
			const defaultConf = await addonApi.defaultConfig(data)
			const addonConf = addonConfig.get(name)
			for (key in defaultConf)
				if (!addonConf.hasOwnProperty(key) || (typeof addonConf[key] !== defaultConf[key].type && defaultConf[key].type != 'select'))
					addonConf[key] = defaultConf[key].default
			addonConfig.set(name, addonConf)
			resolve(addonConf)
		})
	},
	saveAddonConfig: (data, payload) => {
		if (data == '_pimpmystremio')
			return addonApi.saveSettings(payload)
		return new Promise((resolve, reject) => {

			const name = parseRepo(data.repo).repo

			let obj

			try {
				obj = JSON.parse(payload)
			} catch(e) {
				console.error(name + ' - Could not parse settings json')
				reject(e)
			}

			const cloneObj = JSON.parse(JSON.stringify(obj))
			delete cloneObj.repo
			addonConfig.set(name, cloneObj)
			resolve({ success: true })
		})
	},
	getCatalog: async (host, port) => {
//		const hostname = host || ('http://127.0.0.1' + (port ? ':' + port : ''))
		const hostname = host || proxy.getEndpoint()
		const catalog = []
		for (let key in addons) {
			const addon = addons[key]
			if ((addon || {}).manifest)
				catalog.push({
					manifest: addon.manifest,
					transportName: 'http',
					transportUrl: hostname + '/' + key + '/manifest.json'
				})
		}
		return Promise.resolve(catalog)
	},
	run: async (data, isChild) => {
		return new Promise(async (resolve, reject) => {

			if (process.env['NO_CHILDREN'])
				isChild = true

			const name = parseRepo(data.repo).repo

			if (addons[name])
				await addonApi.stop(data, isChild)

			function setRunning() {
				if (!data.sideloaded)
					userConfig.addons.running.add(data)
				else {
					const found = sideloadedAddons.some((addon, ij) => {
						if (addon.repo == data.repo) {
							sideloadedAddons[ij].running = true
							return true
						}
					})
					if (!found) {
						data.running = true
						sideloadedAddons.push(data)
					}
				}
				return true
			}

			if (!isChild) {
				children.create(name).then(data => {
					addons[name] = data
					setRunning()
					resolve({ success: true })
				}).catch(reject)

			} else {

				const cfg = await addonApi.addonConfig(data)

				const persistData = persist.get(name)

				addons[name] = await vm.run({ data, name, config: cfg, persist: persistData })

				if (addons[name]) {
					addons[name]['_persist'] = persistData
					setRunning()
					console.log('Add-on running: ' + data.repo)
					resolve({ success: true })
				} else
					reject(new Error('Could not run add-on: ' + data.repo))
			}
		})
	},
	stop: (data, isChild) => {
		return new Promise((resolve, reject) => {

			if (process.env['NO_CHILDREN'])
				isChild = true

			if (data.sideloaded) {
				sideloadedAddons.some((addon, ij) => {
					if (addon.repo == data.repo) {
						sideloadedAddons[ij].running = false
						return true
					}
				})
			} else {
				userConfig.addons.running.remove(data)
			}
			const name = parseRepo(data.repo).repo
			if (!isChild) {
				children.kill(name).then(resolve).catch(reject)
				if (addons[name])
					addons[name] = null
			} else {
	 			if (addons[name]) {
					if ((addons[name]['_persist'] || {}).getObj)
						persist.set(name, addons[name]['_persist'].getObj())
					addons[name] = null
					console.log('Add-on stopped: ' + data.repo)
					resolve({ success: true })
				} else
					reject('Could not stop add-on, it is not running: ' + name)
			}
		})
	},
	persistAll: () => {
		return new Promise((resolve, reject) => {
			if (process.env['NO_CHILDREN']) {
				for (let key in addons)
					if ((((addons || {})[key] || {})['_persist'] || {}).getObj)
						persist.set(key, addons[key]['_persist'].getObj())
				resolve()
				return
			}

			const q = async.queue((task, callback) => {
				addonApi.stop(addonApi.getManifest(task.key)).then(() => {
					callback()
				}).catch(err => {
					callback()
				})
			})

			q.drain = () => {
				resolve()
			}

			if (Object.keys(addons).length) {
				for (let key in addons)
					q.push({ key })
			} else
				resolve()
		})
	},
	install: data => {
		return new Promise((resolve, reject) => {
			zipBall(data.repo).then(githubData => {
				const repoData = parseRepo(data.repo)
				const dest = path.join(addonsDir, repoData.repo)

				function installAddon() {
					needle('get', githubData.zipBall, { follow_max: 5 })
					.then(async zipFile => {
						const zipped = zipFile.body.toString('base64')
						unzip.extract(zipped, dest)
						data.tag = githubData.tag
						userConfig.addons.installed.add(data)
						const bundled = await bundle(repoData.repo, path.join(dest, 'index.js'), dest, vm.allModules())
						if ((bundled || {}).success) {
							console.log('Add-on installed: ' + data.repo)
							resolve({ success: true })
						} else {
							console.log('Could not bundle installed add-on: ' + data.repo)
							console.log('Add-on failed installation: ' + data.repo)
							reject('Could not bundle installed add-on: ' + data.repo)
						}
					})
					.catch(err => {
						console.log(repoData.repo + ' unzip error')
						console.error(err)
						reject(new Error((err || {}).message || 'Unknown Error Occurred'))
					})
				}

				function cleanDir(dest, cb) {
					fs.stat(dest, err => {
						if (!err)
							rimraf(dest, () => {
								fs.mkdir(dest, cb)
							})
						else if (err.code === 'ENOENT')
							fs.mkdir(dest, cb)
					})
				} 

				cleanDir(dest, installAddon)
			}).catch(err => {
				reject(err)
			})
		})
	},
	update: data => {
		if (!data.tag)
			return addonApi.install(data).catch(err => {
				return Promise.reject(err)
			})
		else
			return zipBall(data.repo).then(githubData => {
				if (data.tag != githubData.tag)
					return addonApi.install(data)
				else
					return Promise.resolve()
			}).catch(err => {
				return Promise.reject(err)
			})
	},
	remove: data => {
		return new Promise((resolve, reject) => {
			addonApi.stop(data).then(() => {
				userConfig.addons.installed.remove(data)
				const name = parseRepo(data.repo).repo
				rimraf(path.join(addonsDir, name))
				console.log('Add-on removed: ' + data.repo)
				resolve({ success: true })
			})
		})
	},
	getAll: () => {
		const userData = userConfig.read()
		const installedAddons = userData.installedAddons.concat(sideloadedAddons)
		const runningAddons = userData.runningAddons.concat(sideloadedAddons)
		return Promise.resolve({ installedAddons, runningAddons, allAddons: allAddons.concat(sideloadedAddons) })
	},
	restart: false,
	init: (installed, callback, rest) => {

		if (rest)
			addonApi.restart = rest

		if (installed && installed.length) {
			const runAddon = (task, cb) => {
				addonApi.run(task).then(resp => {
					cb()
				}).catch(err => {
					console.error(err)
					cb()
				})
			}
			const runQueue = async.queue((task, cb) => {
				if (task.sideloaded) {
					runAddon(task, cb)
					return
				}
				addonApi.update(task).then(() => {
					runAddon(task, cb)
				}).catch(err => {
					console.error(err)
					runAddon(task, cb)
				})
			})

			runQueue.drain = callback

			installed.forEach(data => { runQueue.push(data) })
		} else
			callback()

	}
}

module.exports = addonApi
