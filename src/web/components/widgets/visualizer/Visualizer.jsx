import _ from 'lodash';
import colornames from 'colornames';
import pubsub from 'pubsub-js';
import React from 'react';
import ReactDOM from 'react-dom';
import { THREE, Detector } from '../../../lib/three';
import controller from '../../../lib/controller';
import store from '../../../store';
import Joystick from './Joystick';
import Toolbar from './Toolbar';
import FileUploader from './FileUploader';
import { fitCameraToObject, getBoundingBox, loadTexture } from './helpers';
import CoordinateAxes from './CoordinateAxes';
import ToolHead from './ToolHead';
import GridLine from './GridLine';
import PivotPoint3 from './PivotPoint3';
import TextSprite from './TextSprite';
import GCodeVisualizer from './GCodeVisualizer';
import {
    GRBL_ACTIVE_STATE_UNKNOWN,
    GRBL_ACTIVE_STATE_RUN,
    WORKFLOW_STATE_RUNNING,
    WORKFLOW_STATE_IDLE
} from '../../../constants';

const AXIS_LENGTH = 300;
const GRID_X_LENGTH = 600;
const GRID_Y_LENGTH = 600;
const GRID_X_SPACING = 10;
const GRID_Y_SPACING = 10;
const CAMERA_FOV = 70;
const CAMERA_NEAR = 0.001;
const CAMERA_FAR = 10000;
const CAMERA_POSITION_X = 0;
const CAMERA_POSITION_Y = 0;
const CAMERA_POSITION_Z = 200; // Move the camera out a bit from the origin (0, 0, 0)

class Visualizer extends React.Component {
    workPosition = {
        x: 0,
        y: 0,
        z: 0
    };
    renderAnimation = store.get('widgets.visualizer.animation');
    controllerEvents = {
        'gcode:statuschange': (data) => {
            if (!(this.gcodeVisualizer)) {
                return;
            }

            const frameIndex = data.sent;
            this.gcodeVisualizer.setFrameIndex(frameIndex);
        },
        'grbl:state': (state) => {
            const { status, parserstate } = { ...state };
            const { activeState, workPosition } = status;

            this.parserstate = parserstate;

            if (this.state.activeState !== activeState) {
                this.setState({ activeState: activeState });
            }

            if (_.isEqual(this.workPosition, workPosition)) {
                return;
            }

            // Update workPosition
            this.workPosition = workPosition;

            const pivotPoint = this.pivotPoint.get();

            let { x, y, z } = workPosition;
            x = (Number(x) || 0) - pivotPoint.x;
            y = (Number(y) || 0) - pivotPoint.y;
            z = (Number(z) || 0) - pivotPoint.z;

            if (this.toolhead) {
                // Set tool head position
                this.toolhead.position.set(x, y, z);
            }

            // Update the scene
            this.updateScene();
        }
    };
    storeEventListener = () => {
        const renderAnimation = store.get('widgets.visualizer.animation');
        if (renderAnimation !== this.renderAnimation) {
            this.renderAnimation = renderAnimation;

            this.toolhead.visible = renderAnimation;

            // Update the scene
            this.updateScene();
        }
    };
    pubsubTokens = [];

    constructor() {
        super();
        this.state = this.getDefaultState();
    }
    componentWillMount() {
        // Grbl
        this.parserstate = {};
        this.gcodeVisualizer = null;
        // Three.js
        this.renderer = null;
        this.scene = null;
        this.camera = null;
        this.controls = null;
        this.toolhead = null;
        this.group = new THREE.Group();
    }
    componentDidMount() {
        this.subscribe();
        this.addControllerEvents();
        this.addResizeEventListener();
        store.on('change', this.storeEventListener);

        const el = ReactDOM.findDOMNode(this.refs.visualizer);
        this.createScene(el);
        this.resizeRenderer();

        this.pivotPoint = new PivotPoint3({
            x: 0,
            y: 0,
            z: 0
        }, (x, y, z) => { // The relative xyz position
            _.each(this.group.children, (o) => {
                o.translateX(x);
                o.translateY(y);
                o.translateZ(z);
            });

            // Update the scene
            this.updateScene();
        });
    }
    componentWillUnmount() {
        store.removeListener('change', this.storeEventListener);
        this.removeResizeEventListener();
        this.removeControllerEvents();
        this.unsubscribe();
        this.clearScene();
    }
    shouldComponentUpdate(nextProps, nextState) {
        const props = ['port', 'ready', 'activeState', 'workflowState', 'boundingBox'];
        return !_.isEqual(_.pick(nextState, props), _.pick(this.state, props));
    }
    componentDidUpdate(prevProps, prevState) {
        // The renderAnimationLoop will check the state of activeState and workflowState
        requestAnimationFrame(::this.renderAnimationLoop);
    }
    getDefaultState() {
        return {
            port: controller.port,
            ready: false,
            activeState: GRBL_ACTIVE_STATE_UNKNOWN,
            workflowState: WORKFLOW_STATE_IDLE,
            boundingBox: {
                min: {
                    x: 0,
                    y: 0,
                    z: 0
                },
                max: {
                    x: 0,
                    y: 0,
                    z: 0
                }
            }
        };
    }
    subscribe() {
        const tokens = [
            pubsub.subscribe('port', (msg, port) => {
                port = port || '';

                if (port) {
                    this.setState({ port: port });
                } else {
                    pubsub.publish('gcode:unload');

                    const defaultState = this.getDefaultState();
                    this.setState({
                        ...defaultState,
                        port: ''
                    });
                }
            }),
            pubsub.subscribe('workflowState', (msg, workflowState) => {
                if (this.state.workflowState !== workflowState) {
                    this.setState({ workflowState: workflowState });
                }
            }),
            pubsub.subscribe('gcode:load', (msg, gcode) => {
                gcode = gcode || '';

                this.startWaiting();

                this.loadGCode(gcode, (options) => {
                    pubsub.publish('gcode:boundingBox', options.boundingBox);

                    this.setState({
                        ready: true,
                        boundingBox: options.boundingBox
                    });

                    this.stopWaiting();
                });
            }),
            pubsub.subscribe('gcode:unload', (msg) => {
                this.unloadGCode();
                this.setState({ ready: false });
            }),
            pubsub.subscribe('resize', (msg) => {
                this.resizeRenderer();
            })
        ];
        this.pubsubTokens = this.pubsubTokens.concat(tokens);
    }
    unsubscribe() {
        _.each(this.pubsubTokens, (token) => {
            pubsub.unsubscribe(token);
        });
        this.pubsubTokens = [];
    }
    addControllerEvents() {
        _.each(this.controllerEvents, (callback, eventName) => {
            controller.on(eventName, callback);
        });
    }
    removeControllerEvents() {
        _.each(this.controllerEvents, (callback, eventName) => {
            controller.off(eventName, callback);
        });
    }
    startWaiting() {
        // Adds the 'wait' class to <html>
        const root = document.documentElement;
        root.classList.add('wait');
    }
    stopWaiting() {
        // Adds the 'wait' class to <html>
        const root = document.documentElement;
        root.classList.remove('wait');
    }
    addResizeEventListener() {
        // handle resize event
        if (!(this.onResize)) {
            this.onResize = () => {
                this.resizeRenderer();
            };
        }
        this.onResize();
        this.onResizeThrottled = _.throttle(::this.onResize, 10);
        window.addEventListener('resize', this.onResizeThrottled);
    }
    removeResizeEventListener() {
        // handle resize event
        window.removeEventListener('resize', this.onResizeThrottled);
        this.onResizeThrottled = null;
    }
    resizeRenderer() {
        if (!(this.camera && this.renderer)) {
            return;
        }

        const el = ReactDOM.findDOMNode(this.refs.visualizer);
        const navbarHeight = 50;
        const widgetHeaderHeight = 32;
        const borderWidth = 1;
        const width = el.offsetWidth;
        const height = window.innerHeight - navbarHeight - widgetHeaderHeight - borderWidth;

        // Update the camera aspect ratio (width / height), and set a new size to the renderer.
        // Also see "Window on resize, and aspect ratio #69" at https://github.com/mrdoob/three.js/issues/69
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();

        this.renderer.setSize(width, height);

        // Update the scene
        this.updateScene();
    }
    //
    // Creating a scene
    // http://threejs.org/docs/#Manual/Introduction/Creating_a_scene
    //
    createScene(el) {
        const width = el.clientWidth;
        const height = el.clientHeight;

        // To actually be able to display anything with Three.js, we need three things:
        // A scene, a camera, and a renderer so we can render the scene with the camera.
        this.scene = new THREE.Scene();

        // Creating a renderer
        this.renderer = this.createRenderer(width, height);
        el.appendChild(this.renderer.domElement);

        // Perspective camera
        this.camera = this.createPerspectiveCamera(width, height);

        // Trackball Controls
        this.controls = this.createTrackballControls(this.camera, this.renderer.domElement);

        // Ambient light
        const light = new THREE.AmbientLight(colornames('gray 25')); // soft white light
        this.scene.add(light);

        { // Coordinate Grid
            const gridLine = new GridLine(
                GRID_X_LENGTH,
                GRID_X_SPACING,
                GRID_Y_LENGTH,
                GRID_Y_SPACING,
                colornames('blue'), // center line
                colornames('gray 44') // grid
            );
            _.each(gridLine.children, (o) => {
                o.material.opacity = 0.15;
                o.material.transparent = true;
                o.material.depthWrite = false;
            });
            gridLine.name = 'GridLine';
            this.group.add(gridLine);
        }

        { // Coordinate Axes
            const coordinateAxes = new CoordinateAxes(AXIS_LENGTH);
            coordinateAxes.name = 'CoordinateAxes';
            this.group.add(coordinateAxes);
        }

        { // Axis Labels
            const axisXLabel = new TextSprite({
                x: AXIS_LENGTH + 10,
                y: 0,
                z: 0,
                size: 20,
                text: 'X',
                color: colornames('red')
            });
            const axisYLabel = new TextSprite({
                x: 0,
                y: AXIS_LENGTH + 10,
                z: 0,
                size: 20,
                text: 'Y',
                color: colornames('green')
            });
            const axisZLabel = new TextSprite({
                x: 0,
                y: 0,
                z: AXIS_LENGTH + 10,
                size: 20,
                text: 'Z',
                color: colornames('blue')
            });

            this.group.add(axisXLabel);
            this.group.add(axisYLabel);
            this.group.add(axisZLabel);

            for (let i = -GRID_X_LENGTH; i <= GRID_X_LENGTH; i += 50) {
                if (i === 0) {
                    continue;
                }
                const textLabel = new TextSprite({
                    x: i,
                    y: 10,
                    z: 0,
                    size: 8,
                    text: i,
                    color: colornames('red'),
                    opacity: 0.5
                });
                this.group.add(textLabel);
            }
            for (let i = -GRID_Y_LENGTH; i <= GRID_Y_LENGTH; i += 50) {
                if (i === 0) {
                    continue;
                }
                const textLabel = new TextSprite({
                    x: -10,
                    y: i,
                    z: 0,
                    size: 8,
                    text: i,
                    color: colornames('green'),
                    opacity: 0.5
                });
                this.group.add(textLabel);
            }
        }

        { // Tool Head
            const color = colornames('silver');
            const url = 'textures/brushed-steel-texture.jpg';
            loadTexture(url, (err, texture) => {
                this.toolhead = new ToolHead(color, texture);
                this.toolhead.name = 'ToolHead';
                this.toolhead.visible = this.state.renderAnimation;
                this.group.add(this.toolhead);

                // Update the scene
                this.updateScene();
            });
        }

        this.scene.add(this.group);

        return this.scene;
    }
    updateScene() {
        this.renderer.render(this.scene, this.camera);
    }
    clearScene() {
        // to iterrate over all children (except the first) in a scene
        const objsToRemove = _.tail(this.scene.children);
        _.each(objsToRemove, (obj) => {
            this.scene.remove(obj);
        });

        // Update the scene
        this.updateScene();
    }
    renderAnimationLoop() {
        const { renderAnimation, activeState, workflowState } = this.state;
        const isAgitated = renderAnimation
            && (activeState === GRBL_ACTIVE_STATE_RUN)
            && (workflowState === WORKFLOW_STATE_RUNNING);

        if (isAgitated) {
            // Call the render() function up to 60 times per second (i.e. 60fps)
            requestAnimationFrame(::this.renderAnimationLoop);

            // Set to 360 rounds per minute (rpm)
            this.rotateToolHead(360);
        } else {
            // Stop rotation
            this.rotateToolHead(0);
        }

        // Update the scene
        this.updateScene();
    }
    createRenderer(width, height) {
        const options = {
            autoClearColor: true,
            antialias: true,
            alpha: true
        };
        const renderer = Detector.webgl
            ? new THREE.WebGLRenderer(options)
            : new THREE.CanvasRenderer(options);
        renderer.setClearColor(new THREE.Color(colornames('white')), 1);
        renderer.setSize(width, height);
        if (Detector.webgl) {
            renderer.shadowMap.enabled = true;
            renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        }
        renderer.clear();

        return renderer;
    }
    createPerspectiveCamera(width, height) {
        const fov = CAMERA_FOV;
        const aspect = Number(width) / Number(height);
        const near = CAMERA_NEAR;
        const far = CAMERA_FAR;
        const camera = new THREE.PerspectiveCamera(fov, aspect, near, far);

        camera.position.x = CAMERA_POSITION_X;
        camera.position.y = CAMERA_POSITION_Y;
        camera.position.z = CAMERA_POSITION_Z;

        return camera;
    }
    createTrackballControls(object, domElement) {
        const controls = new THREE.TrackballControls(object, domElement);

        controls.rotateSpeed = 1.0;
        controls.zoomSpeed = 0.5;
        controls.panSpeed = 1.0;
        controls.dynamicDampingFactor = 0.15;
        controls.minDistance = 1;
        controls.maxDistance = 5000;

        let shouldAnimate = false;
        const animate = () => {
            controls.update();

            // Update the scene
            this.updateScene();

            if (shouldAnimate) {
                requestAnimationFrame(animate);
            }
        };

        controls.addEventListener('start', () => {
            shouldAnimate = true;
            animate();
        });
        controls.addEventListener('end', () => {
            shouldAnimate = false;
        });
        controls.addEventListener('change', () => {
            // Update the scene
            this.updateScene();
        });

        return controls;
    }
    // Rotates the tool head around the z axis with a given rpm and an optional fps
    // @param {number} rpm The rounds per minutes
    // @param {number} [fps] The frame rate (Defaults to 60 frames per second)
    rotateToolHead(rpm = 0, fps = 60) {
        if (!this.toolhead) {
            return;
        }

        const delta = 1 / fps;
        const degrees = 360 * (delta * Math.PI / 180); // Rotates 360 degrees per second
        this.toolhead.rotateZ(-(rpm / 60 * degrees)); // rotate in clockwise direction
    }
    // Make the controls look at the specified position
    lookAt(x, y, z) {
        this.controls.target.x = x;
        this.controls.target.y = y;
        this.controls.target.z = z;
        this.controls.update();
    }
    // Make the controls look at the center position
    lookAtCenter() {
        this.controls.reset();
    }
    loadGCode(gcode, callback) {
        // Remove previous G-code object
        this.unloadGCode();

        const el = ReactDOM.findDOMNode(this.refs.visualizer);

        this.gcodeVisualizer = new GCodeVisualizer({
            modalState: this.parserstate.modal
        });

        this.gcodeVisualizer.render({
            gcode: gcode,
            width: el.clientWidth,
            height: el.clientHeight
        }, (obj) => {
            obj.name = 'GCodeVisualizer';
            this.group.add(obj);

            const bbox = getBoundingBox(obj);
            const dX = bbox.max.x - bbox.min.x;
            const dY = bbox.max.y - bbox.min.y;
            const dZ = bbox.max.z - bbox.min.z;
            const center = new THREE.Vector3(
                bbox.min.x + (dX / 2),
                bbox.min.y + (dY / 2),
                bbox.min.z + (dZ / 2)
            );

            // Set the pivot point to the object's center position
            this.pivotPoint.set(center.x, center.y, center.z);

            { // Fit the camera to object
                const objectWidth = dX;
                const objectHeight = dY;
                const lookTarget = new THREE.Vector3(0, 0, bbox.max.z);

                fitCameraToObject(this.camera, objectWidth, objectHeight, lookTarget);
            }

            // Update the scene
            this.updateScene();

            (typeof callback === 'function') && callback({ boundingBox: bbox });
        });
    }
    unloadGCode() {
        const gcodeVisualizerObject = this.group.getObjectByName('GCodeVisualizer');
        if (gcodeVisualizerObject) {
            this.group.remove(gcodeVisualizerObject);
        }

        // Sets the pivot point to the origin point (0, 0, 0)
        this.pivotPoint.set(0, 0, 0);

        // Reset controls
        this.controls.reset();

        // Update the scene
        this.updateScene();
    }
	// deltaX and deltaY are in pixels; right and down are positive
    pan(deltaX, deltaY) {
        const eye = new THREE.Vector3();
        const pan = new THREE.Vector3();
        const objectUp = new THREE.Vector3();

        eye.subVectors(this.controls.object.position, this.controls.target);
        objectUp.copy(this.controls.object.up);

        pan.copy(eye).cross(objectUp.clone()).setLength(deltaX);
        pan.add(objectUp.clone().setLength(deltaY));

        this.controls.object.position.add(pan);
        this.controls.target.add(pan);
        this.controls.update();
    }
    // http://stackoverflow.com/questions/18581225/orbitcontrol-or-trackballcontrol
    panUp() {
        const { ready } = this.state;
        const { noPan, panSpeed } = this.controls;

        if (!ready || noPan) {
            return;
        }

        this.pan(0, 1 * panSpeed);
    }
    panDown() {
        const { ready } = this.state;
        const { noPan, panSpeed } = this.controls;

        if (!ready || noPan) {
            return;
        }

        this.pan(0, -1 * panSpeed);
    }
    panLeft() {
        const { ready } = this.state;
        const { noPan, panSpeed } = this.controls;

        if (!ready || noPan) {
            return;
        }

        this.pan(1 * panSpeed, 0);
    }
    panRight() {
        const { ready } = this.state;
        const { noPan, panSpeed } = this.controls;

        if (!ready || noPan) {
            return;
        }

        this.pan(-1 * panSpeed, 0);
    }
    render() {
        const { port, ready, activeState } = this.state;
        const hasLoaded = !!port && ready;
        const notLoaded = !hasLoaded;

        return (
            <div>
                <Toolbar
                    port={port}
                    ready={ready}
                    activeState={activeState}
                />
                <Joystick
                    ready={ready}
                    up={::this.panUp}
                    down={::this.panDown}
                    left={::this.panLeft}
                    right={::this.panRight}
                    center={::this.lookAtCenter}
                />
                {notLoaded &&
                    <FileUploader port={port} />
                }
                <div ref="visualizer" className="visualizer" />
            </div>
        );
    }
}

export default Visualizer;
