import React from 'react'
import classnames from 'classnames'
import {MdContentCopy, MdVisibility, MdVisibilityOff, MdDelete} from 'react-icons/md'
import { IconContext } from 'react-icons'
import {useSortable} from '@dnd-kit/sortable'
import {CSS} from '@dnd-kit/utilities'
import {useTranslation} from 'react-i18next'

import IconLayer from './IconLayer'
import {SAMPLE_SIZES} from '../libs/poi-sample'


type DraggableLabelProps = {
  layerId: string
  layerLabel?: string
  layerType: string
  dragAttributes?: React.HTMLAttributes<HTMLElement>
  dragListeners?: React.HTMLAttributes<HTMLElement>
};

const DraggableLabel: React.FC<DraggableLabelProps> = (props) => {
  const {dragAttributes, dragListeners} = props;
  return <div className="maputnik-layer-list-item-handle" {...dragAttributes} {...dragListeners}>
    <IconLayer
      className="layer-handle__icon"
      type={props.layerType}
    />
    <button className="maputnik-layer-list-item-id" title={props.layerId}>
      {props.layerLabel || props.layerId}
    </button>
  </div>
};

type IconActionProps = {
  action: string
  onClick(...args: unknown[]): unknown
  wdKey?: string
  classBlockName?: string
  classBlockModifier?: string
};

class IconAction extends React.Component<IconActionProps> {
  renderIcon() {
    switch(this.props.action) {
    case 'duplicate': return <MdContentCopy />
    case 'show': return <MdVisibility />
    case 'hide': return <MdVisibilityOff />
    case 'delete': return <MdDelete />
    }
  }

  render() {
    const {classBlockName, classBlockModifier} = this.props;

    let classAdditions = '';
    if (classBlockName) {
      classAdditions = `maputnik-layer-list-icon-action__${classBlockName}`;

      if (classBlockModifier) {
        classAdditions += ` maputnik-layer-list-icon-action__${classBlockName}--${classBlockModifier}`;
      }
    }

    return <button
      tabIndex={-1}
      title={this.props.action}
      className={`maputnik-layer-list-icon-action ${classAdditions}`}
      data-wd-key={this.props.wdKey}
      onClick={this.props.onClick}
      aria-hidden="true"
    >
      {this.renderIcon()}
    </button>
  }
}

type SampleControlProps = {
  layerId: string
  layerIndex: number
  size: number | null
  onSample(index: number, size: number | null): unknown
};

/** 5 / 10 / 15: keep only that many of the bucket's POIs, picked at random
 *  from the current view. The active count re-rolls when clicked again;
 *  "all" puts everything back. Only POI bucket rows get this. */
const SampleControl: React.FC<SampleControlProps> = (props) => {
  const {t} = useTranslation();
  const active = props.size;
  return <span
    className={classnames({
      "maputnik-layer-list-sample": true,
      "maputnik-layer-list-sample--active": active !== null,
    })}
    // The row itself selects the layer on click; a count is not a selection.
    onClick={e => e.stopPropagation()}
    title={t("Keep only a random few of this layer's POIs from the current view; click the same number again to re-roll")}
  >
    {SAMPLE_SIZES.map(size => <button
      key={size}
      type="button"
      tabIndex={-1}
      data-wd-key={`layer-list-item:${props.layerId}:sample-${size}`}
      className={classnames({
        "maputnik-layer-list-sample__size": true,
        "maputnik-layer-list-sample__size--active": active === size,
      })}
      onClick={() => props.onSample(props.layerIndex, size)}
    >{size}</button>)}
    {active !== null && <button
      type="button"
      tabIndex={-1}
      data-wd-key={`layer-list-item:${props.layerId}:sample-all`}
      className="maputnik-layer-list-sample__size maputnik-layer-list-sample__clear"
      title={t("Show every POI again")}
      onClick={() => props.onSample(props.layerIndex, null)}
    >{t("all")}</button>}
  </span>
};

type LayerListItemProps = {
  id?: string
  layerIndex: number
  layerId: string
  layerLabel?: string
  layerType: string
  isSelected?: boolean
  visibility?: string
  className?: string
  /** A generated POI category/rank bucket: gets the sample control. */
  poiBucket?: boolean
  sampleSize?: number | null
  onLayerSelect(...args: unknown[]): unknown
  onLayerCopy?(...args: unknown[]): unknown
  onLayerDestroy?(...args: unknown[]): unknown
  onLayerVisibilityToggle?(...args: unknown[]): unknown
  onLayerSample?(index: number, size: number | null): unknown
};

const LayerListItem = React.forwardRef<HTMLLIElement, LayerListItemProps>((props, ref) => {
  const {
    isSelected = false,
    visibility = 'visible',
    onLayerCopy = () => {},
    onLayerDestroy = () => {},
    onLayerVisibilityToggle = () => {},
  } = props;

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({id: props.layerId});

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const visibilityAction = visibility === 'visible' ? 'show' : 'hide';

  // Cast ref to MutableRefObject since we know from the codebase that's what's always passed
  const refObject = ref as React.MutableRefObject<HTMLLIElement | null> | null;

  return <IconContext.Provider value={{size: '14px'}}>
    <li
      ref={(node) => {
        setNodeRef(node);
        if (refObject) {
          refObject.current = node;
        }
      }}
      style={style}
      id={props.id}
      onClick={_e => props.onLayerSelect(props.layerIndex)}
      data-wd-key={"layer-list-item:" + props.layerId}
      className={classnames({
        "maputnik-layer-list-item": true,
        "maputnik-layer-list-item-selected": isSelected,
        [props.className!]: true,
      })}>
      <DraggableLabel
        layerId={props.layerId}
        layerLabel={props.layerLabel}
        layerType={props.layerType}
        dragAttributes={attributes}
        dragListeners={listeners}
      />
      <span style={{flexGrow: 1}} />
      {props.poiBucket && props.onLayerSample && <SampleControl
        layerId={props.layerId}
        layerIndex={props.layerIndex}
        size={props.sampleSize ?? null}
        onSample={props.onLayerSample}
      />}
      <IconAction
        wdKey={"layer-list-item:" + props.layerId+":delete"}
        action={'delete'}
        classBlockName="delete"
        onClick={_e => onLayerDestroy!(props.layerIndex)}
      />
      <IconAction
        wdKey={"layer-list-item:" + props.layerId+":copy"}
        action={'duplicate'}
        classBlockName="duplicate"
        onClick={_e => onLayerCopy!(props.layerIndex)}
      />
      <IconAction
        wdKey={"layer-list-item:"+props.layerId+":toggle-visibility"}
        action={visibilityAction}
        classBlockName="visibility"
        classBlockModifier={visibilityAction}
        onClick={_e => onLayerVisibilityToggle!(props.layerIndex)}
      />
    </li>
  </IconContext.Provider>
});

export default LayerListItem;
