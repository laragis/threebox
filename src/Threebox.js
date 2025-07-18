
/**
 * @author peterqliu / https://github.com/peterqliu
 * @author jscastro / https://github.com/jscastro76
 */

const THREE = require("./three.js");
const CameraSync = require("./camera/CameraSync.js");
const utils = require("./utils/utils.js");
const SunCalc = require("./utils/suncalc.js");
const ThreeboxConstants = require("./utils/constants.js");
const Objects = require("./objects/objects.js");
const material = require("./utils/material.js");
const sphere = require("./objects/sphere.js");
const extrusion = require("./objects/extrusion.js");
const label = require("./objects/label.js");
const tooltip = require("./objects/tooltip.js");
const loader = require("./objects/loadObj.js");
const Object3D = require("./objects/Object3D.js");
const line = require("./objects/line.js");
const tube = require("./objects/tube.js");
const LabelRenderer = require("./objects/LabelRenderer.js");
const BuildingShadows = require("./objects/effects/BuildingShadows.js");
const CacheManager = require("./cache/CacheManager.js");

function Threebox(map, glContext, options){

    this.init(map, glContext, options);

};

Threebox.prototype = {

	repaint: function () {
		this.map.repaint = true;
	},

	/**
	 * Threebox constructor init method
	 * @param {mapboxgl.map} map
	 * @param {WebGLRenderingContext} glContext
	 * @param {defaultOptions} options
	 */
	init: function (map, glContext, options) {

		// apply starter options
		this.options = utils._validate(options || {}, defaultOptions);

		this.map = map;
		this.map.tb = this; //[jscastro] needed if we want to queryRenderedFeatures from map.onload

		/** @nhan.tt */
		this.objects = new Objects(this.map);

		this.mapboxVersion = parseFloat(this.map.version); 

		// Set up a THREE.js scene
		this.renderer = new THREE.WebGLRenderer({
			alpha: true,
			antialias: true,
			preserveDrawingBuffer: options.preserveDrawingBuffer,
			canvas: map.getCanvas(),
			context: glContext
		});

		this.renderer.setPixelRatio(window.devicePixelRatio);
		this.renderer.setSize(this.map.getCanvas().clientWidth, this.map.getCanvas().clientHeight);
		this.renderer.outputEncoding = THREE.sRGBEncoding;
		this.renderer.autoClear = false;

		// [jscastro] set labelRendered
		this.labelRenderer = new LabelRenderer(this.map);

		this.scene = new THREE.Scene();
		this.world = new THREE.Group();
		this.world.name = "world";
		this.scene.add(this.world);

		/** @nhan.tt */
		// Initialize persistent cache manager
		const cacheOptions = this.options.cache || {};
		this.cacheManager = new CacheManager({
			cacheName: cacheOptions.cacheName || 'threebox-cache',
			maxAge: cacheOptions.maxAge || this.options.maxCacheAge || 7 * 24 * 60 * 60 * 1000, // 7 days default
			maxCacheEntries: cacheOptions.maxCacheEntries || this.options.maxCacheEntries || 100 // Max number of cached items
		});

		this.objectsCache = new Map();
		this.zoomLayers = [];

		this.fov = this.options.fov;
		this.orthographic = this.options.orthographic || false;

		//raycaster for mouse events
		this.raycaster = new THREE.Raycaster();
		this.raycaster.layers.set(0);
		//this.raycaster.params.Points.threshold = 100;

		this.mapCenter = this.map.getCenter();
		this.mapCenterUnits = utils.projectToWorld([this.mapCenter.lng, this.mapCenter.lat]);
		this.lightDateTime = new Date();
		this.lightLng = this.mapCenter.lng;
		this.lightLat = this.mapCenter.lat;
		this.sunPosition;
		this.rotationStep = 5;// degrees step size for rotation
		this.gridStep = 6;// decimals to adjust the lnglat grid step, 6 = 11.1cm
		this.altitudeStep = 0.1; // 1px = 0.1m = 10cm
		this.defaultCursor = 'default';

		this.lights = this.initLights;
		if (this.options.defaultLights) this.defaultLights();
		if (this.options.realSunlight) this.realSunlight(this.options.realSunlightHelper);
		this.skyLayerName = 'sky-layer';
		this.terrainSourceName = 'mapbox-dem';
		this.terrainExaggeration = 1.0;
		this.terrainLayerName = '';
		this.enableSelectingFeatures = this.options.enableSelectingFeatures || false;
		this.enableSelectingObjects = this.options.enableSelectingObjects || false;
		this.enableDraggingObjects = this.options.enableDraggingObjects || false;
		this.enableRotatingObjects = this.options.enableRotatingObjects || false;
		this.enableTooltips = this.options.enableTooltips || false;
		this.multiLayer = this.options.multiLayer || false;
		this.enableHelpTooltips = this.options.enableHelpTooltips || false;

		this.map.on('style.load', function () {
			this.tb.zoomLayers = [];
			//[jscastro] if multiLayer, create a by default layer in the map, so tb.update won't be needed in client side to avoid duplicating calls to render
			if (this.tb.options.multiLayer) this.addLayer({ id: "threebox_layer", type: 'custom', renderingMode: '3d', map: this, onAdd: function (map, gl) { }, render: function (gl, matrix) { this.map.tb.update(); } })

			this.once('idle', () => {
				this.tb.setObjectsScale();
			});

			if (this.tb.options.sky) {
				this.tb.sky = true;
			}
			if (this.tb.options.terrain) {
				this.tb.terrain = true;
			}
			let rasterLayers = ['satellite', 'mapbox-mapbox-satellite', 'satelliteLayer'];
			rasterLayers.forEach((l) => {
				if (this.getLayer(l)) this.tb.terrainLayerName = l;
			})
		});

		//[jscastro] new event map on load
		this.map.on('load', function () {

			//[jscastro] new fields to manage events on map
			this.selectedObject; //selected object through click
			this.selectedFeature;//selected state id for extrusion layer features
			this.draggedObject; //dragged object through mousedown + mousemove
			let draggedAction; //dragged action to notify frontend
			this.overedObject; //overed object through mouseover
			this.overedFeature; //overed state for extrusion layer features

			let canvas = this.getCanvasContainer();
			this.getCanvasContainer().style.cursor = this.tb.defaultCursor;
			// Variable to hold the starting xy coordinates
			// when 'mousedown' occured.
			let start;

			//when object selected
			let startCoords = [];

			let lngDiff; // difference between cursor and model left corner
			let latDiff; // difference between cursor and model bottom corner
			let altDiff; // difference between cursor and model height
			let rotationDiff; 

			// Return the xy coordinates of the mouse position
			function mousePos(e) {
				var rect = canvas.getBoundingClientRect();
				return {
					x: e.originalEvent.clientX - rect.left - canvas.clientLeft,
					y: e.originalEvent.clientY - rect.top - canvas.clientTop
				};
			}
			
			this.unselectObject = function () {
				//deselect, reset and return
				this.selectedObject.selected = false;
				this.selectedObject = null;
			}

			this.outObject = function () {
				this.overedObject.over = false;
				this.overedObject = null;
			}

			this.unselectFeature = function (f) {
				if (typeof f.id == 'undefined') return;
				this.setFeatureState(
					{ source: f.source, sourceLayer: f.sourceLayer, id: f.id },
					{ select: false }
				);

				this.removeTooltip(f);
				f = this.queryRenderedFeatures({ layers: [f.layer.id], filter: ["==", ['id'], f.id] })[0];
				// Dispatch new event f for unselected
				if (f) this.fire('SelectedFeatureChange', { detail: f });
				this.selectedFeature = null;

			}

			this.selectFeature = function(f) {
				this.selectedFeature = f;
				this.setFeatureState(
					{ source: this.selectedFeature.source, sourceLayer: this.selectedFeature.sourceLayer, id: this.selectedFeature.id },
					{ select: true }
				);
				this.selectedFeature = this.queryRenderedFeatures({ layers: [this.selectedFeature.layer.id], filter: ["==", ['id'], this.selectedFeature.id] })[0];
				this.addTooltip(this.selectedFeature);
				// Dispatch new event SelectedFeature for selected
				this.fire('SelectedFeatureChange', { detail: this.selectedFeature });

			}

			this.outFeature = function(f) {
				if (this.overedFeature && typeof this.overedFeature != 'undefined' && this.overedFeature.id != f) {
					map.setFeatureState(
						{ source: this.overedFeature.source, sourceLayer: this.overedFeature.sourceLayer, id: this.overedFeature.id },
						{ hover: false }
					);
					this.removeTooltip(this.overedFeature);
					this.overedFeature = null;
				}
			}

			this.addTooltip = function(f) {
				if (!this.tb.enableTooltips) return;
				let coordinates = this.tb.getFeatureCenter(f);
				let t = this.tb.tooltip({
					text: f.properties.name || f.id || f.type,
					mapboxStyle: true,
					feature: f
				});
				t.setCoords(coordinates);
				this.tb.add(t, f.layer.id);
				f.tooltip = t;
				f.tooltip.tooltip.visible = true;
			}

			this.removeTooltip = function(f) {
				if (f.tooltip) {
					f.tooltip.visibility = false;
					this.tb.remove(f.tooltip);
					f.tooltip = null;
				}
			}

			map.onContextMenu = function (e) {
				alert('contextMenu'); //TODO: implement a callback
			}

			// onclick function
			this.onClick = function (e) {
				let intersectionExists
				let intersects = [];
				if (map.tb.enableSelectingObjects) {
					//raycast only if we are in a custom layer, for other layers go to the else, this avoids duplicated calls to raycaster
					intersects = this.tb.queryRenderedFeatures(e.point);
				}
				intersectionExists = typeof intersects[0] == 'object';
				// if intersect exists, highlight it
				if (intersectionExists) {

					let nearestObject = Threebox.prototype.findParent3DObject(intersects[0]);

					if (nearestObject) {
						//if extrusion object selected, unselect
						if (this.selectedFeature) {
							this.unselectFeature(this.selectedFeature);
						}
						//if not selected yet, select it
						if (!this.selectedObject) {
							this.selectedObject = nearestObject;
							this.selectedObject.selected = true;
						}
						else if (this.selectedObject.uuid != nearestObject.uuid) {
							//it's a different object, restore the previous and select the new one
							this.selectedObject.selected = false;
							nearestObject.selected = true;
							this.selectedObject = nearestObject;

						} else if (this.selectedObject.uuid == nearestObject.uuid) {
							//deselect, reset and return
							this.unselectObject();
							return;
						}

						// fire the Wireframed event to notify UI status change
						this.selectedObject.dispatchEvent({ type: 'Wireframed', detail: this.selectedObject });
						this.selectedObject.dispatchEvent({ type: 'IsPlayingChanged', detail: this.selectedObject });

						this.repaint = true;
						e.preventDefault();
					}
				}
				else {
					let features = [];
					if (map.tb.enableSelectingFeatures) {
						features = this.queryRenderedFeatures(e.point);
					}
					//now let's check the extrusion layer objects
					if (features.length > 0) {

						if (features[0].layer.type == 'fill-extrusion' && typeof features[0].id != 'undefined') {

							//if 3D object selected, unselect
							if (this.selectedObject) {
								this.unselectObject();
							}

							//if not selected yet, select it
							if (!this.selectedFeature) {
								this.selectFeature(features[0])
							}
							else if (this.selectedFeature.id != features[0].id) {
								//it's a different feature, restore the previous and select the new one
								this.unselectFeature(this.selectedFeature);
								this.selectFeature(features[0])

							} else if (this.selectedFeature.id == features[0].id) {
								//deselect, reset and return
								this.unselectFeature(this.selectedFeature);
								return;
							}

						}
					}
				}
			}

			this.onMouseMove = function (e) {

				// Capture the ongoing xy coordinates
				let current = mousePos(e);

				this.getCanvasContainer().style.cursor = this.tb.defaultCursor;
				//check if being rotated
				if (e.originalEvent.altKey && this.draggedObject) {

					if (!map.tb.enableRotatingObjects) return;
					draggedAction = 'rotate';
					// Set a UI indicator for dragging.
					this.getCanvasContainer().style.cursor = 'move';
					var minX = Math.min(start.x, current.x),
						maxX = Math.max(start.x, current.x),
						minY = Math.min(start.y, current.y),
						maxY = Math.max(start.y, current.y);
					//set the movement fluid we rotate only every 10px moved, in steps of 10 degrees up to 360
					let rotation = { x: 0, y: 0, z: (Math.round(rotationDiff[2] + (~~((current.x - start.x) / this.tb.rotationStep) % 360 * this.tb.rotationStep) % 360)) };
					//now rotate the model depending the axis
					this.draggedObject.setRotation(rotation);
					if (map.tb.enableHelpTooltips) this.draggedObject.addHelp("rot: " + rotation.z + "&#176;");
					//this.draggedObject.setRotationAxis(rotation);
					return;
				}

				//check if being moved
				if (e.originalEvent.shiftKey && this.draggedObject) {
					if (!map.tb.enableDraggingObjects) return;

					draggedAction = 'translate';
					// Set a UI indicator for dragging.
					this.getCanvasContainer().style.cursor = 'move';
					// Capture the first xy coordinates, height must be the same to move on the same plane
					let coords = e.lngLat;
					let options = [Number((coords.lng + lngDiff).toFixed(this.tb.gridStep)), Number((coords.lat + latDiff).toFixed(this.tb.gridStep)), this.draggedObject.modelHeight];
					this.draggedObject.setCoords(options);
					if (map.tb.enableHelpTooltips) this.draggedObject.addHelp("lng: " + options[0] + "&#176;, lat: " + options[1] + "&#176;");
					return;
				}

				//check if being moved on altitude
				if (e.originalEvent.ctrlKey && this.draggedObject) {
					if (!map.tb.enableDraggingObjects) return;
					draggedAction = 'altitude';
					// Set a UI indicator for dragging.
					this.getCanvasContainer().style.cursor = 'move';
					// Capture the first xy coordinates, height must be the same to move on the same plane
					let now = (e.point.y * this.tb.altitudeStep);
					let options = [this.draggedObject.coordinates[0], this.draggedObject.coordinates[1], Number((- now - altDiff).toFixed(this.tb.gridStep))];
					this.draggedObject.setCoords(options);
					if (map.tb.enableHelpTooltips) this.draggedObject.addHelp("alt: " + options[2] + "m");
					return;
				}

				let intersectionExists
				let intersects = [];

				if (map.tb.enableSelectingObjects) {
					// calculate objects intersecting the picking ray
					intersects = this.tb.queryRenderedFeatures(e.point);
				}
				intersectionExists = typeof intersects[0] == 'object';

				// if intersect exists, highlight it, if not check the extrusion layer
				if (intersectionExists) {
					let nearestObject = Threebox.prototype.findParent3DObject(intersects[0]);
					if (nearestObject) {
						this.outFeature(this.overedFeature);
						this.getCanvasContainer().style.cursor = 'pointer';
						if (!this.selectedObject || nearestObject.uuid != this.selectedObject.uuid) {
							if (this.overedObject && this.overedObject.uuid != nearestObject.uuid) {
								this.outObject();
							}
							nearestObject.over = true;
							this.overedObject = nearestObject;
						} else if (this.selectedObject && nearestObject.uuid == this.selectedObject.uuid) {
							nearestObject.over = true;
							this.overedObject = nearestObject;
						}
						this.repaint = true;
						e.preventDefault();
					}
				}
				else {
					//clean the object overed
					if (this.overedObject) { this.outObject(); }
					//now let's check the extrusion layer objects
					let features = [];
					if (map.tb.enableSelectingFeatures) {
						features = this.queryRenderedFeatures(e.point);
					}
					if (features.length > 0) {
						this.outFeature(features[0]);

						if (features[0].layer.type == 'fill-extrusion' && typeof features[0].id != 'undefined') {
							if ((!this.selectedFeature || this.selectedFeature.id != features[0].id)) {
								this.getCanvasContainer().style.cursor = 'pointer';
								this.overedFeature = features[0];
								this.setFeatureState(
									{ source: this.overedFeature.source, sourceLayer: this.overedFeature.sourceLayer, id: this.overedFeature.id },
									{ hover: true }
								);
								this.overedFeature = map.queryRenderedFeatures({ layers: [this.overedFeature.layer.id], filter: ["==", ['id'], this.overedFeature.id] })[0];
								this.addTooltip(this.overedFeature);

							}
						}
					}
				}

			}

			this.onMouseDown = function (e) {

				// Continue the rest of the function shiftkey or altkey are pressed, and if object is selected
				if (!((e.originalEvent.shiftKey || e.originalEvent.altKey || e.originalEvent.ctrlKey) && e.originalEvent.button === 0 && this.selectedObject)) return;
				if (!map.tb.enableDraggingObjects && !map.tb.enableRotatingObjects) return;

				e.preventDefault();

				map.getCanvasContainer().style.cursor = 'move';

				// Disable default drag zooming when the shift key is held down.
				//map.dragPan.disable();

				// Call functions for the following events
				map.once('mouseup', this.onMouseUp);
				//map.once('mouseout', this.onMouseUp);

				// move the selected object
				this.draggedObject = this.selectedObject;

				// Capture the first xy coordinates
				start = mousePos(e);
				startCoords = this.draggedObject.coordinates;

				rotationDiff = utils.degreeify(this.draggedObject.rotation);
				lngDiff = startCoords[0] - e.lngLat.lng;
				latDiff = startCoords[1] - e.lngLat.lat;
				altDiff = -this.draggedObject.modelHeight - (e.point.y * this.tb.altitudeStep);
			}

			this.onMouseUp = function (e) {

				// Set a UI indicator for dragging.
				this.getCanvasContainer().style.cursor = this.tb.defaultCursor;

				// Remove these events now that finish has been called.
				//map.off('mousemove', onMouseMove);
				this.off('mouseup', this.onMouseUp);
				this.off('mouseout', this.onMouseUp);
				this.dragPan.enable();

				if (this.draggedObject) {
					this.draggedObject.dispatchEvent({ type: 'ObjectDragged', detail: { draggedObject: this.draggedObject, draggedAction: draggedAction } });
					this.draggedObject.removeHelp();
					this.draggedObject = null;
					draggedAction = null;
				};
			}

			this.onMouseOut = function (e) {
				if (this.overedFeature) {
					let features = this.queryRenderedFeatures(e.point);
					if (features.length > 0 && this.overedFeature.id != features[0].id) {
						this.getCanvasContainer().style.cursor = this.tb.defaultCursor;
						//only unover when new feature is another
						this.outFeature(features[0]);
					}
				}
			}

			this.onZoom = function (e) {
				this.tb.zoomLayers.forEach((l) => { this.tb.toggleLayer(l); });
				this.tb.setObjectsScale();
			}

			let ctrlDown = false;
			let shiftDown = false;
			let ctrlKey = 17, cmdKey = 91, shiftKey = 16, sK = 83, dK = 68;

			function onKeyDown(e) {

				if (e.which === ctrlKey || e.which === cmdKey) ctrlDown = true;
				if (e.which === shiftKey) shiftDown = true;
				let obj = this.selectedObject;
				if (shiftDown && e.which === sK && obj) {
					//shift + sS
					let dc = utils.toDecimal;
					if (!obj.help) {
						let s = obj.modelSize;
						let sf = 1;
						if (obj.userData.units !== 'meters') {
							//if not meters, calculate scale to the current lat
							sf = utils.projectedUnitsPerMeter(obj.coordinates[1]);
							if (!sf) { sf = 1; };
							sf = dc(sf, 7);
						}

						if (map.tb.enableHelpTooltips) obj.addHelp("size(m): " + dc((s.x / sf), 3) + " W, " + dc((s.y / sf), 3) + " L, " + dc((s.z / sf), 3) + " H");
						this.repaint = true;
					}
					else {
						obj.removeHelp();
					}
					return false;
				}

			};

			function onKeyUp (e) {
				if (e.which == ctrlKey || e.which == cmdKey) ctrlDown = false;
				if (e.which === shiftKey) shiftDown = false;
			}

			//listener to the events
			//this.on('contextmenu', map.onContextMenu);
			this.on('click', this.onClick);
			this.on('mousemove', this.onMouseMove);
			this.on('mouseout', this.onMouseOut)
			this.on('mousedown', this.onMouseDown);
			this.on('zoom', this.onZoom);
			this.on('zoomend', this.onZoom);

			document.addEventListener('keydown', onKeyDown.bind(this), true);
			document.addEventListener('keyup', onKeyUp.bind(this));

		});

	},

	//[jscastro] added property to manage an athmospheric sky layer
	get sky() { return this.options.sky; },
	set sky(value) {
		if (value) {
			this.createSkyLayer();
		}
		else {
			this.removeLayer(this.skyLayerName);
		}
		this.options.sky = value;
	},

	//[jscastro] added property to manage an athmospheric sky layer
	get terrain() { return this.options.terrain; },
	set terrain(value) {
		this.terrainLayerName = '';
		if (value) {
			this.createTerrainLayer();
		}
		else {
			if (this.mapboxVersion < 2.0) { console.warn("Terrain layer are only supported by Mapbox-gl-js > v2.0"); return };

			if (this.map.getTerrain()) {
				this.map.setTerrain(null); //
				this.map.removeSource(this.terrainSourceName);
			}
		}
		this.options.terrain = value;
	},

	//[jscastro] added property to manage FOV for perspective camera
	get fov() { return this.options.fov;},
	set fov(value) {
		if (this.camera instanceof THREE.PerspectiveCamera && this.options.fov !== value) {
			this.map.transform.fov = value;
			this.camera.fov = this.map.transform.fov;
			this.cameraSync.setupCamera();
			this.map.repaint = true;
			this.options.fov = value;
		}

	},

	//[jscastro] added property to manage camera type
	get orthographic() { return this.options.orthographic; },
	set orthographic(value) {
		const h = this.map.getCanvas().clientHeight;
		const w = this.map.getCanvas().clientWidth;
		if (value) {
			this.map.transform.fov = 0;
			this.camera = new THREE.OrthographicCamera(w / - 2, w / 2, h / 2, h / - 2, 0.1, 1e21);
		} else {
			this.map.transform.fov = this.fov;
			this.camera = new THREE.PerspectiveCamera(this.map.transform.fov, w / h, 0.1, 1e21);
		}
		this.camera.layers.enable(0);
		this.camera.layers.enable(1);
		// The CameraSync object will keep the Mapbox and THREE.js camera movements in sync.
		// It requires a world group to scale as we zoom in. Rotation is handled in the camera's
		// projection matrix itself (as is field of view and near/far clipping)
		// It automatically registers to listen for move events on the map so we don't need to do that here
		this.cameraSync = new CameraSync(this.map, this.camera, this.world);
		this.map.repaint = true; // repaint the map
		this.options.orthographic = value;

	},

	//[jscastro] method to create an athmospheric sky layer
	createSkyLayer: function () {
		if (this.mapboxVersion < 2.0) { console.warn("Sky layer are only supported by Mapbox-gl-js > v2.0"); this.options.sky = false; return };

		let layer = this.map.getLayer(this.skyLayerName);
		if (!layer) {
			this.map.addLayer({
				'id': this.skyLayerName,
				'type': 'sky',
				'paint': {
					'sky-opacity': [
						'interpolate',
						['linear'],
						['zoom'],
						0,
						0,
						5,
						0.3,
						8,
						1
					],
					// set up the sky layer for atmospheric scattering
					'sky-type': 'atmosphere',
					// explicitly set the position of the sun rather than allowing the sun to be attached to the main light source
					'sky-atmosphere-sun': this.getSunSky(this.lightDateTime),
					// set the intensity of the sun as a light source (0-100 with higher values corresponding to brighter skies)
					'sky-atmosphere-sun-intensity': 10
				}
			});

			this.map.once('idle', () => {
				this.setSunlight();
				this.repaint();
			});
		}
	},

	//[jscastro] method to create a terrain layer
	createTerrainLayer: function () {
		if (this.mapboxVersion < 2.0) { console.warn("Terrain layer are only supported by Mapbox-gl-js > v2.0"); this.options.terrain = false; return };
		let layer = this.map.getTerrain();
		if (!layer) {
			// add the DEM source as a terrain layer with exaggerated height
			this.map.addSource(this.terrainSourceName, {
				'type': 'raster-dem',
				'url': 'mapbox://mapbox.mapbox-terrain-dem-v1',
				'tileSize': 512,
				'maxzoom': 14
			});
			this.map.setTerrain({ 'source': this.terrainSourceName, 'exaggeration': this.terrainExaggeration });
			this.map.once('idle', () => {
				//alert("idle");
				this.cameraSync.updateCamera();
				this.repaint();
			});

		}
	},

	// Objects
	sphere: function (options) {
		this.setDefaultView(options, this.options);
		return sphere(options, this.world)
	},

	line: line,

	label: label,

	tooltip: tooltip,

	tube: function (options) {
		this.setDefaultView(options, this.options);
		return tube(options, this.world)
	},

	extrusion: function (options) {
		this.setDefaultView(options, this.options);
		return extrusion(options);
	},

	Object3D: function (options) {
		this.setDefaultView(options, this.options);
		return Object3D(options)
	},

	
	/** @nhan.tt */
	_createBlobUrlFromResponse: async function(response) {
		const arrayBuffer = await response.clone().arrayBuffer();
		const blob = new Blob([arrayBuffer]);
		return URL.createObjectURL(blob);
	},

	/** @nhan.tt */
	_loadWithBlobUrl: function(options, cb, resolve, blobUrl) {
		return new Promise((resolveLoader) => {
			loader(options, (obj) => {
				// Clean up the blob URL after loading
				URL.revokeObjectURL(blobUrl);
				if (cb) cb(obj);
			}, (obj) => {
				// Clean up the blob URL after loading
				URL.revokeObjectURL(blobUrl);
				resolve(obj);
			});
		});
	},

	/** @nhan.tt */
	_loadWithFallback: function(options, cb, resolve) {
		return new Promise((resolveLoader) => {
			loader(options, (obj) => {
				if (cb) cb(obj);
			}, (obj) => {
				resolve(obj);
			});
		});
	},

	/** @nhan.tt */
	_loadNonCached: function(options, cb) {
		return new Promise(async (resolve) => {
			loader(options, cb, async (obj) => {
				resolve(obj);
			});
		});
	},

	/** @nhan.tt */
	_cacheResponse: async function(cachedResponse, options, cb, resolve) {
		// Create a blob URL from cached data for the loader
		const blobUrl = await this._createBlobUrlFromResponse(cachedResponse);

		// Use the blob URL with the loader
		const modifiedOptions = { ...options, obj: blobUrl };
		return this._loadWithBlobUrl(modifiedOptions, cb, resolve, blobUrl);
	},

	/** @nhan.tt */
	loadObj: async function loadObj(options, cb) {
		this.setDefaultView(options, this.options);
		if (options.clone === false) {
			return this._loadNonCached(options, cb);
		}
		else {
			return new Promise(async (resolve, reject) => {
				try {
					// Check if the obj is a URL (for Mapbox-style caching)
					const urlPrefix = ["http://", "https://", "./", "/"];
					const isUrl = typeof options.obj === 'string' && urlPrefix.some(prefix => options.obj.startsWith(prefix));

					if (isUrl) {
						// Use Mapbox-style URL caching for remote/local files
						try {
							let cachedResponse = await this.cacheManager.getFromUrl(options.obj);
							
							if (cachedResponse) {
								// console.log(`Cache HIT for model: ${options.obj}`);
								// Restore object from cache
								return this._cacheResponse(cachedResponse, options, cb, resolve);
							} else {
								const response = await this.cacheManager.cacheFileFromUrl(options.obj);
								
								if (response) {
									// console.log(`Cache MISS for model: ${options.obj}`);
									// Cache the file first, then use the cached response
									return this._cacheResponse(response, options, cb, resolve);
								} else {
									// If caching failed, fall back to normal loading
									return this._loadWithFallback(options, cb, resolve);
								}
							}
						} catch (error) {
							console.warn('Error with Mapbox-style caching, falling back to traditional loading:', error);
							return this._loadWithFallback(options, cb, resolve);
						}
					}

					// // Fallback to traditional caching for non-URL objects or if Mapbox-style caching fails
					// // Generate cache key from URL and relevant options
					// const cacheKey = this.cacheManager.generateKey(options.obj, {
					// 	type: options.type,
					// 	scale: options.scale,
					// 	units: options.units
					// });

					// // First check persistent cache
					// try {
					// 	const cachedData = await this.cacheManager.get(cacheKey);
					// 	if (cachedData) {
					// 		// Restore object from cache
					// 		const cachedObj = this.restoreObjectFromCache(cachedData, options);
					// 		if (cachedObj) {
					// 			const duplicatedObj = cachedObj.duplicate ? cachedObj.duplicate(options) : cachedObj;
					// 			if (cb) cb(duplicatedObj);
					// 			resolve(duplicatedObj);
					// 			return;
					// 		}
					// 	}
					// } catch (error) {
					// 	console.warn('Error accessing persistent cache:', error);
					// }

					// // Check in-memory cache as fallback
					// let cache = this.objectsCache.get(options.obj);
					// if (cache) {
					// 	cache.promise
					// 		.then(async obj => {
					// 			// Store in persistent cache for future use
					// 			try {
					// 				const cacheData = this.prepareObjectForCache(obj);
					// 				await this.cacheManager.set(cacheKey, cacheData, {
					// 					url: options.obj,
					// 					timestamp: Date.now(),
					// 					type: options.type || 'model'
					// 				});
					// 			} catch (error) {
					// 				console.warn('Error storing object in persistent cache:', error);
					// 			}
								
					// 			const duplicatedObj = obj.duplicate(options);
					// 			if (cb) cb(duplicatedObj);
					// 			resolve(duplicatedObj);
					// 		})
					// 		.catch(err => {
					// 			this.objectsCache.delete(options.obj);
					// 			console.error("Could not load model file: " + options.obj);
					// 			reject(err);
					// 		});
					// } else {
					// 	this.objectsCache.set(options.obj, {
					// 		promise: new Promise(
					// 			async (resolveLoader, rejectLoader) => {
					// 				loader(options, (obj) => {
					// 					// Callback function - handle user callback here
					// 					if (obj && obj.duplicate && cb) {
					// 						cb(obj.duplicate(options));
					// 					}
					// 				}, async (obj) => {
					// 					// Promise function - handle promise resolution here
					// 					if (obj && obj.duplicate) {
					// 						// Store in persistent cache
					// 						try {
					// 							const cacheData = this.prepareObjectForCache(obj);
					// 							await this.cacheManager.set(cacheKey, cacheData, {
					// 								url: options.obj,
					// 								timestamp: Date.now(),
					// 								type: options.type || 'model'
					// 							});
					// 						} catch (error) {
					// 							console.warn('Error storing object in persistent cache:', error);
					// 						}
											
					// 						resolveLoader(obj);
					// 						resolve(obj.duplicate(options));
					// 					} else if (typeof obj === 'string') {
					// 						// Error case
					// 						const error = new Error(obj);
					// 						rejectLoader(error);
					// 						reject(error);
					// 					} else {
					// 						// Unknown case
					// 						const error = new Error('Failed to load object');
					// 						rejectLoader(error);
					// 						reject(error);
					// 					}
					// 				});
					// 			})
					// 	});
					// }
				} catch (error) {
					console.error('Error in loadObj:', error);
					reject(error);
				}
			});
		}
	},

	/** @nhan.tt */
	loadFile: async function(url, options = {}) {
		if (!this.cacheManager) {
			throw new Error('Cache manager not initialized');
		}

		try {
			return await this.cacheManager.loadFile(url, options);
		} catch (error) {
			console.error('Failed to load file with caching:', error);
			throw error;
		}
	},

	/** @nhan.tt */
	cacheFile: async function(url, options = {}) {
		if (!this.cacheManager) {
			throw new Error('Cache manager not initialized');
		}

		try {
			return await this.cacheManager.cacheFileFromUrl(url, options);
		} catch (error) {
			console.error('Failed to cache file:', error);
			throw error;
		}
	},

	/** @nhan.tt */
	getCachedFile: async function(url) {
		if (!this.cacheManager) {
			return null;
		}

		try {
			return await this.cacheManager.getFromUrl(url);
		} catch (error) {
			console.error('Failed to get cached file:', error);
			return null;
		}
	},

	/** @nhan.tt */
	prepareObjectForCache: function(obj) {
		try {
			// Extract cacheable data from the object
			const cacheData = {
				type: 'ThreeboxObject',
				geometry: this.serializeGeometry(obj.geometry),
				material: this.serializeMaterial(obj.material),
				position: obj.position.toArray(),
				rotation: obj.rotation.toArray(),
				scale: obj.scale.toArray(),
				userData: obj.userData,
				name: obj.name,
				uuid: obj.uuid,
				timestamp: Date.now()
			};

			// Handle children if they exist
			if (obj.children && obj.children.length > 0) {
				cacheData.children = obj.children.map(child => this.prepareObjectForCache(child));
			}

			return cacheData;
		} catch (error) {
			console.warn('Error preparing object for cache:', error);
			return null;
		}
	},

	/** @nhan.tt */
	restoreObjectFromCache: function(cacheData, options) {
		try {
			if (!cacheData || cacheData.type !== 'ThreeboxObject') {
				return null;
			}

			// Create a new object from cached data
			const geometry = this.deserializeGeometry(cacheData.geometry);
			const material = this.deserializeMaterial(cacheData.material);
			
			const obj = new THREE.Mesh(geometry, material);
			
			// Restore properties
			obj.position.fromArray(cacheData.position);
			obj.rotation.fromArray(cacheData.rotation);
			obj.scale.fromArray(cacheData.scale);
			obj.userData = cacheData.userData || {};
			obj.name = cacheData.name || '';
			
			// Add essential Threebox methods
			obj.duplicate = function(opts = {}) {
				const duplicated = obj.clone();
				duplicated.userData = { ...obj.userData, ...opts };
				
				// Ensure the cloned object also has Threebox methods
				duplicated.setCoords = obj.setCoords;
				duplicated.getCoords = obj.getCoords;
				duplicated.duplicate = obj.duplicate;
				
				return duplicated;
			};

			// Add essential Threebox coordinate methods
			obj.setCoords = function(coords) {
				if (this.userData && this.userData.feature) {
					this.userData.feature.geometry.coordinates = coords;
				}
				// Convert coordinates to world position
				const worldCoords = utils.projectToWorld(coords);
				this.position.set(worldCoords[0], worldCoords[1], worldCoords[2] || 0);
			};

			obj.getCoords = function() {
				// Convert world position back to coordinates
				return utils.unprojectFromWorld(this.position);
			};

			// Restore children if they exist
			if (cacheData.children) {
				cacheData.children.forEach(childData => {
					const child = this.restoreObjectFromCache(childData, options);
					if (child) {
						obj.add(child);
					}
				});
			}

			return obj;
		} catch (error) {
			console.warn('Error restoring object from cache:', error);
			return null;
		}
	},

	/** @nhan.tt */
	serializeGeometry: function(geometry) {
		if (!geometry) return null;
		
		try {
			return {
				type: geometry.type,
				attributes: {
					position: geometry.attributes.position ? geometry.attributes.position.array : null,
					normal: geometry.attributes.normal ? geometry.attributes.normal.array : null,
					uv: geometry.attributes.uv ? geometry.attributes.uv.array : null
				},
				index: geometry.index ? geometry.index.array : null,
				boundingBox: geometry.boundingBox,
				boundingSphere: geometry.boundingSphere
			};
		} catch (error) {
			console.warn('Error serializing geometry:', error);
			return null;
		}
	},

	/** @nhan.tt */
	deserializeGeometry: function(geometryData) {
		if (!geometryData) return new THREE.BufferGeometry();
		
		try {
			const geometry = new THREE.BufferGeometry();
			
			if (geometryData.attributes.position) {
				geometry.setAttribute('position', new THREE.Float32BufferAttribute(geometryData.attributes.position, 3));
			}
			if (geometryData.attributes.normal) {
				geometry.setAttribute('normal', new THREE.Float32BufferAttribute(geometryData.attributes.normal, 3));
			}
			if (geometryData.attributes.uv) {
				geometry.setAttribute('uv', new THREE.Float32BufferAttribute(geometryData.attributes.uv, 2));
			}
			if (geometryData.index) {
				geometry.setIndex(new THREE.Uint16BufferAttribute(geometryData.index, 1));
			}
			
			return geometry;
		} catch (error) {
			console.warn('Error deserializing geometry:', error);
			return new THREE.BufferGeometry();
		}
	},

	/** @nhan.tt */
	serializeMaterial: function(material) {
		if (!material) return null;
		
		try {
			const materialData = {
				type: material.type,
				color: material.color ? material.color.getHex() : null,
				opacity: material.opacity,
				transparent: material.transparent,
				side: material.side
			};

			// Handle textures (store only the image URL for now)
			if (material.map && material.map.image && material.map.image.src) {
				materialData.mapSrc = material.map.image.src;
			}

			return materialData;
		} catch (error) {
			console.warn('Error serializing material:', error);
			return null;
		}
	},

	/** @nhan.tt */
	deserializeMaterial: function(materialData) {
		if (!materialData) return new THREE.MeshBasicMaterial();
		
		try {
			let material;
			
			switch (materialData.type) {
				case 'MeshBasicMaterial':
					material = new THREE.MeshBasicMaterial();
					break;
				case 'MeshLambertMaterial':
					material = new THREE.MeshLambertMaterial();
					break;
				case 'MeshPhongMaterial':
					material = new THREE.MeshPhongMaterial();
					break;
				default:
					material = new THREE.MeshBasicMaterial();
			}
			
			if (materialData.color !== null) {
				material.color.setHex(materialData.color);
			}
			material.opacity = materialData.opacity || 1.0;
			material.transparent = materialData.transparent || false;
			material.side = materialData.side || THREE.FrontSide;

			// Restore texture if available
			if (materialData.mapSrc) {
				const textureLoader = new THREE.TextureLoader();
				material.map = textureLoader.load(materialData.mapSrc);
			}

			return material;
		} catch (error) {
			console.warn('Error deserializing material:', error);
			return new THREE.MeshBasicMaterial();
		}
	},

	/** @nhan.tt */
	clearCache: async function() {
		// Clear memory cache
		this.objectsCache.clear();
		
		// Clear persistent cache
		if (this.cacheManager) {
			await this.cacheManager.clear();
		}
	},

	/** @nhan.tt */
	getCacheStats: async function() {
		const stats = {
			memoryCache: this.objectsCache.size,
			persistent: null
		};
		
		if (this.cacheManager) {
			stats.persistent = await this.cacheManager.getStats();
		}
		
		return stats;
	},

	// Material

	material: function (o) {
		return material(o)
	},

	initLights : {
		ambientLight: null,
		dirLight: null,
		dirLightBack: null,
		dirLightHelper: null,
		hemiLight: null,
		pointLight: null
	},

	utils: utils,

	SunCalc: SunCalc,

	Constants: ThreeboxConstants,

	projectToWorld: function (coords) {
		return this.utils.projectToWorld(coords)
	},

	unprojectFromWorld: function (v3) {
		return this.utils.unprojectFromWorld(v3)
	},

	projectedUnitsPerMeter: function (lat) {
		return this.utils.projectedUnitsPerMeter(lat)
	},

	//get the center point of a feature
	getFeatureCenter: function getFeatureCenter(feature, obj, level) {
		return utils.getFeatureCenter(feature, obj, level);
	},

	getObjectHeightOnFloor: function (feature, obj, level) {
		return utils.getObjectHeightOnFloor(feature, obj, level);
	},

	queryRenderedFeatures: function (point) {

		let mouse = new THREE.Vector2();

		// // scale mouse pixel position to a percentage of the screen's width and height
		mouse.x = (point.x / this.map.transform.width) * 2 - 1;
		mouse.y = 1 - (point.y / this.map.transform.height) * 2;

		this.raycaster.setFromCamera(mouse, this.camera);

		// calculate objects intersecting the picking ray
		let intersects = this.raycaster.intersectObjects(this.world.children, true);

		return intersects
	},

	//[jscastro] find 3D object of a mesh. this method is needed to know the object of a raycasted mesh
	findParent3DObject: function (mesh) {
		//find the Parent Object3D of the mesh captured by Raytracer
		var result;
		mesh.object.traverseAncestors(function (m) {
			if (m.parent)
				if (m.parent.type == "Group" && m.userData.obj) {
					result = m;
				}
		});
		return result;
	},

	//[jscastro] method to replicate behaviour of map.setLayoutProperty when Threebox are affected
	setLayoutProperty: function (layerId, name, value) {
		//first set layout property at the map
		this.map.setLayoutProperty(layerId, name, value);
		if (value !== null && value !== undefined) {
			if (name === 'visibility') {
				this.world.children.filter(o => (o.layer === layerId)).forEach((o) => { o.visibility = value });
			}
		}
	},

	//[jscastro] Custom Layers doesn't work on minzoom and maxzoom attributes, and if the layer is including labels they don't hide either on minzoom
	setLayerZoomRange: function (layerId, minZoomLayer, maxZoomLayer) {
		if (this.map.getLayer(layerId)) {
			this.map.setLayerZoomRange(layerId, minZoomLayer, maxZoomLayer);
			if (!this.zoomLayers.includes(layerId)) this.zoomLayers.push(layerId);
			this.toggleLayer(layerId);
		}
	},

	//[jscastro] method to set the height of all the objects in a level. this only works if the objects have a geojson feature
	setLayerHeigthProperty: function (layerId, level) {
		let layer = this.map.getLayer(layerId);
		if (!layer) return;
		if (layer.type == "fill-extrusion") {
			let data = this.map.getStyle().sources[layer.source].data;
			let features = data.features;
			features.forEach(function (f) {
				f.properties.level = level;
			});
			//we change the level on the source
			this.map.getSource(layer.source).setData(data);
		} else if (layer.type == "custom") {
			this.world.children.forEach(function (obj) {
				let feature = obj.userData.feature;
				if (feature && feature.layer === layerId) {
					//TODO: this could be a multidimensional array
					let location = this.tb.getFeatureCenter(feature, obj, level);
					obj.setCoords(location);
				}
			});
		}
	},

	//[jscastro] method to set globally all the objects that are fixedScale
	setObjectsScale: function () {
		this.world.children.filter(o => (o.fixedZoom != null)).forEach((o) => { o.setObjectScale(this.map.transform.scale); });
	},

	//[jscastro] mapbox setStyle removes all the layers, including custom layers, so tb.world must be cleaned up too
	setStyle: function (styleId, options) {
		this.clear().then(() => {
			this.map.setStyle(styleId, options);
		});
	},

	//[jscastro] method to toggle Layer visibility checking zoom range
	toggleLayer: function (layerId, visible = true) {
		let l = this.map.getLayer(layerId);
		if (l) {
			if (!visible) {
				this.toggle(l.id, false);
				return;
			}
			let z = this.map.getZoom();
			if (l.minzoom && z < l.minzoom) { this.toggle(l.id, false); return; };
			if (l.maxzoom && z >= l.maxzoom) { this.toggle(l.id, false); return; };
			this.toggle(l.id, true);
		};
	},

	//[jscastro] method to toggle Layer visibility
	toggle: function (layerId, visible) {
		//call
		this.setLayoutProperty(layerId, 'visibility', (visible ? 'visible' : 'none'))
		this.labelRenderer.toggleLabels(layerId, visible);
	},

	update: function () {

		if (this.map.repaint) this.map.repaint = false

		var timestamp = Date.now();

		// Update any animations
		this.objects.animationManager.update(timestamp);

		this.updateLightHelper();

		// Render the scene and repaint the map
		this.renderer.resetState(); //update threejs r126
		this.renderer.render(this.scene, this.camera);

		// [jscastro] Render any label
		this.labelRenderer.render(this.scene, this.camera);
		if (this.options.passiveRendering === false) this.map.triggerRepaint();
	},

	add: function (obj, layerId, sourceId) {
		//[jscastro] remove the tooltip if not enabled
		if (!this.enableTooltips && obj.tooltip) { obj.tooltip.visibility = false };
		this.world.add(obj);
		if (layerId) {
			obj.layer = layerId;
			obj.source = sourceId;
			let l = this.map.getLayer(layerId);
			if (l) {
				let v = l.visibility;
				let u = typeof v === 'undefined';
				obj.visibility = (u || v === 'visible' ? true : false);
			}
		}
	},

	removeByName: function (name) {
		let obj = this.world.getObjectByName(name);
		if (obj) this.remove(obj);
	},

	remove: function (obj) {
		if (this.map.selectedObject && obj.uuid == this.map.selectedObject.uuid) this.map.unselectObject();
		if (this.map.draggedObject && obj.uuid == this.map.draggedObject.uuid) this.map.draggedObject = null;
		if (obj.dispose) obj.dispose();
		this.world.remove(obj);
		obj = null;
	},

	//[jscastro] this clears tb.world in order to dispose properly the resources
	clear: async function (layerId = null, dispose = false) {
		return new Promise((resolve, reject) => {
			let objects = [];
			this.world.children.forEach(function (object) {
				objects.push(object);
			});
			for (let i = 0; i < objects.length; i++) {
				let obj = objects[i];
				//if layerId, check the layer to remove, otherwise always remove
				if (obj.layer === layerId || !layerId) {
					this.remove(obj);
				}
			}
			if (dispose) {
				this.objectsCache.forEach((value) => {
					value.promise.then(obj => {
						obj.dispose();
						obj = null;
					})
				})
			}

			resolve("clear");
		});
	},

	//[jscastro] remove a layer clearing first the 3D objects from this layer in tb.world
	removeLayer: function (layerId) {
		this.clear(layerId, true).then( () => {
			this.map.removeLayer(layerId);
		});
	},

	//[jscastro] get the sun position (azimuth, altitude) from a given datetime, lng, lat
	getSunPosition: function (date, coords) {
		return SunCalc.getPosition(date || Date.now(), coords[1], coords[0]);  
	},

	//[jscastro] get the sun times for sunrise, sunset, etc.. from a given datetime, lng, lat and alt
	getSunTimes: function (date, coords) {
		return SunCalc.getTimes(date, coords[1], coords[0], (coords[2] ? coords[2] : 0));
	},

	//[jscastro] set shadows for fill-extrusion layers
	setBuildingShadows: function (options) {
		if (this.map.getLayer(options.buildingsLayerId)) {
			let layer = new BuildingShadows(options, this);
			this.map.addLayer(layer, options.buildingsLayerId);
		}
		else {
			console.warn("The layer '" + options.buildingsLayerId + "' does not exist in the map.");
		}
	},

	//[jscastro] This method set the sun light for a given datetime and lnglat
	setSunlight: function (newDate = new Date(), coords) {
		if (!this.lights.dirLight || !this.options.realSunlight) {
			console.warn("To use setSunlight it's required to set realSunlight : true in Threebox initial options.");
			return;
		}

		var date = new Date(newDate.getTime());

		if (coords) {
			if (coords.lng && coords.lat) this.mapCenter = coords
			else this.mapCenter = { lng: coords[0], lat: coords[1] };
		}
		else {
			this.mapCenter = this.map.getCenter();
		}

		if (this.lightDateTime && this.lightDateTime.getTime() === date.getTime() && this.lightLng === this.mapCenter.lng && this.lightLat === this.mapCenter.lat) {
			return; //setSunLight could be called on render, so due to performance, avoid duplicated calls
		}

		this.lightDateTime = date;
		this.lightLng = this.mapCenter.lng; 
		this.lightLat = this.mapCenter.lat
		this.sunPosition = this.getSunPosition(date, [this.mapCenter.lng, this.mapCenter.lat]);  
		let altitude = this.sunPosition.altitude;
		let azimuth = Math.PI + this.sunPosition.azimuth;
		//console.log("Altitude: " + utils.degreeify(altitude) + ", Azimuth: " + (utils.degreeify(azimuth)));

		let radius = ThreeboxConstants.WORLD_SIZE / 2;
		let alt = Math.sin(altitude);
		let altRadius = Math.cos(altitude);
		let azCos = Math.cos(azimuth) * altRadius;
		let azSin = Math.sin(azimuth) * altRadius;

		this.lights.dirLight.position.set(azSin, azCos, alt);
		this.lights.dirLight.position.multiplyScalar(radius);
		this.lights.dirLight.intensity = Math.max(alt, 0);
		this.lights.hemiLight.intensity = Math.max(alt * 1, 0.1);
		//console.log("Intensity:" + this.lights.dirLight.intensity);
		this.lights.dirLight.updateMatrixWorld();
		this.updateLightHelper();
		if (this.map.loaded()) {
			this.updateSunGround(this.sunPosition);
			this.map.setLight({
				anchor: 'map',
				position: [3, 180 + this.sunPosition.azimuth * 180 / Math.PI, 90 - this.sunPosition.altitude * 180 / Math.PI],
				intensity: Math.cos(this.sunPosition.altitude), //0.4,
				color: `hsl(40, ${50 * Math.cos(this.sunPosition.altitude)}%, ${Math.max(20, 20 + (96 * Math.sin(this.sunPosition.altitude)))}%)`

			}, { duration: 0 });
			if (this.sky) { this.updateSunSky(this.getSunSky(date, this.sunPosition));}
		}
	},

	getSunSky: function (date, sunPos) {
		if (!sunPos) {
			var center = this.map.getCenter();
			sunPos = this.getSunPosition(
				date || Date.now(), [center.lng, center.lat]
			);
		}
		var sunAzimuth = 180 + (sunPos.azimuth * 180) / Math.PI;
		var sunAltitude = 90 - (sunPos.altitude * 180) / Math.PI;
		return [sunAzimuth, sunAltitude];
	},

	updateSunSky: function (sunPos) {
		if (this.sky) {
			// update the `sky-atmosphere-sun` paint property with the position of the sun based on the selected time
			this.map.setPaintProperty(this.skyLayerName, 'sky-atmosphere-sun', sunPos);
		}
	},

	updateSunGround: function (sunPos) {
		if (this.terrainLayerName != '') {
			// update the raster layer paint property with the position of the sun based on the selected time
			this.map.setPaintProperty(this.terrainLayerName, 'raster-opacity', Math.max(Math.min(1, sunPos.altitude * 4), 0.25));
		}
	},

	//[jscastro] this updates the directional light helper
	updateLightHelper: function () {
		if (this.lights.dirLightHelper) {
			this.lights.dirLightHelper.position.setFromMatrixPosition(this.lights.dirLight.matrixWorld);
			this.lights.dirLightHelper.updateMatrix();
			this.lights.dirLightHelper.update();
		}
	},

	/** @nhan.tt */
	//[jscastro] method to fully dispose the resources, watch out is you call this without navigating to other page
	dispose: async function () {

		// console.log(this.memory());
		// console.log(window.performance.memory);

		return new Promise((resolve) => {
			resolve(
				this.clear(null, true).then(async (resolve) => {
					this.map.remove();
					this.map = {};
					this.scene.remove(this.world);
					this.world.children = [];
					this.world = null;
					this.objectsCache.clear();
					
					// Clear persistent cache
					if (this.cacheManager) {
						try {
							await this.cacheManager.clear();
						} catch (error) {
							console.warn('Error clearing persistent cache during dispose:', error);
						}
					}
					
					this.labelRenderer.dispose();
					// console.log(this.memory());
					this.renderer.dispose();
					return resolve;
				})
			);
			//console.log(window.performance.memory);
		});

	},

	defaultLights: function () {

		this.lights.ambientLight = new THREE.AmbientLight(new THREE.Color('hsl(0, 0%, 100%)'), 0.75);
		this.scene.add(this.lights.ambientLight);

		this.lights.dirLightBack = new THREE.DirectionalLight(new THREE.Color('hsl(0, 0%, 100%)'), 0.25);
		this.lights.dirLightBack.position.set(30, 100, 100);
		this.scene.add(this.lights.dirLightBack);

		this.lights.dirLight  = new THREE.DirectionalLight(new THREE.Color('hsl(0, 0%, 100%)'), 0.25);
		this.lights.dirLight.position.set(-30, 100, -100);
		this.scene.add(this.lights.dirLight);

	},

	realSunlight: function (helper = false) {

		this.renderer.shadowMap.enabled = true;
		//this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
		this.lights.dirLight = new THREE.DirectionalLight(0xffffff, 1);
		this.scene.add(this.lights.dirLight);
		if (helper) {
			this.lights.dirLightHelper = new THREE.DirectionalLightHelper(this.lights.dirLight, 5);
			this.scene.add(this.lights.dirLightHelper);
		}
		let d2 = 1000; let r2 = 2; let mapSize2 = 8192;
		this.lights.dirLight.castShadow = true;
		this.lights.dirLight.shadow.radius = r2;
		this.lights.dirLight.shadow.mapSize.width = mapSize2;
		this.lights.dirLight.shadow.mapSize.height = mapSize2;
		this.lights.dirLight.shadow.camera.top = this.lights.dirLight.shadow.camera.right = d2;
		this.lights.dirLight.shadow.camera.bottom = this.lights.dirLight.shadow.camera.left = -d2;
		this.lights.dirLight.shadow.camera.near = 1;
		this.lights.dirLight.shadow.camera.visible = true;
		this.lights.dirLight.shadow.camera.far = 400000000; 

		this.lights.hemiLight = new THREE.HemisphereLight(new THREE.Color(0xffffff), new THREE.Color(0xffffff), 0.6);
		this.lights.hemiLight.color.setHSL(0.661, 0.96, 0.12);
		this.lights.hemiLight.groundColor.setHSL(0.11, 0.96, 0.14);
		this.lights.hemiLight.position.set(0, 0, 50);
		this.scene.add(this.lights.hemiLight);
		this.setSunlight();

		this.map.once('idle', () => {
			this.setSunlight();
			this.repaint();
		});

	},

	setDefaultView: function (options, defOptions) {
		options.bbox = (options.bbox || options.bbox == null) && defOptions.enableSelectingObjects;
		options.tooltip = (options.tooltip || options.tooltip == null) && defOptions.enableTooltips;
		options.mapScale = this.map.transform.scale;
	},

	memory: function () { return this.renderer.info.memory },

	programs: function () { return this.renderer.info.programs.length },

	version: '2.2.7',

}

/** @nhan.tt */
var defaultOptions = {
	defaultLights: false,
	realSunlight: false,
	realSunlightHelper: false,
	passiveRendering: true,
	preserveDrawingBuffer: false,
	enableSelectingFeatures: false,
	enableSelectingObjects: false,
	enableDraggingObjects: false,
	enableRotatingObjects: false,
	enableTooltips: false,
	enableHelpTooltips: false,
	multiLayer: false,
	orthographic: false,
	fov: ThreeboxConstants.FOV_DEGREES,
	sky: false,
	terrain: false,
	maxCacheEntries: 100, // Max number of cached items
	maxCacheAge: 7 * 24 * 60 * 60 * 1000 // 7 days default cache age
}
module.exports = exports = Threebox;

